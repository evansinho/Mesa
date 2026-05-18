import './otel'
import Redis from 'ioredis'
import { config } from '@mesa/config'
import { getDb, closeDb } from '@mesa/db'
import { MesaNatsClient } from '@mesa/nats'
import { SUBJECTS, InboundMessageEvent, PaymentScreenshotReceivedEvent, OrderDetectedEvent, NotificationSendEvent, OrderConfirmedEvent, PaymentConfirmedEvent, InventoryLowEvent } from '@mesa/types'
import { orders, products, orderItems, conversations, merchants, agentTasks, messageTemplates } from '@mesa/db'
import { eq, and, lte, lt, gte, inArray } from 'drizzle-orm'
import { MessageHandler } from './handlers/message.handler'
import { PaymentHandler } from './handlers/payment.handler'
import { OrderHandler } from './handlers/order.handler'
import { NotificationHandler } from './handlers/notification.handler'
import { InventoryHandler } from './handlers/inventory.handler'
import { PendingDecisions } from './handlers/pending-decisions'
import { AiQuota } from './ai/quota'
import * as Sentry from '@sentry/node'
import Fastify, { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { EventStore } from './events/event-store'
import { OutboxPublisher } from './events/outbox-publisher'
import cron from 'node-cron'

const log = {
  info: (data: Record<string, unknown>, msg: string) => {
    console.log(JSON.stringify({ level: 'info', msg, ...data }))
  },
  warn: (data: Record<string, unknown>, msg: string) => {
    console.warn(JSON.stringify({ level: 'warn', msg, ...data }))
  },
  error: (data: Record<string, unknown>, msg: string) => {
    console.error(JSON.stringify({ level: 'error', msg, ...data }))
  },
}

if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: 0.1,
  })
}

process.on('unhandledRejection', (err) => {
  if (config.SENTRY_DSN) {
    Sentry.captureException(err, { tags: { service: 'worker' } })
  }
})

process.on('uncaughtException', (err) => {
  if (config.SENTRY_DSN) {
    Sentry.captureException(err, { tags: { service: 'worker' } })
  }
  log.error({ service: 'worker', err }, 'Uncaught exception')
  process.exit(1)
})

let app: FastifyInstance | null = null
let outboxPublisherRef: OutboxPublisher | null = null

async function start() {
  const db = getDb(config.DATABASE_URL)
  const redis = new Redis(config.REDIS_URL)
  const nats = new MesaNatsClient()
  app = Fastify({ logger: false })

  await nats.connect(config.NATS_URL)

  const eventStore = new EventStore(db, nats, config.OUTBOX_MODE)
  const pendingDecisions = new PendingDecisions(db, redis)
  const aiQuota = new AiQuota(db, redis, log)
  outboxPublisherRef = new OutboxPublisher(db, nats, redis, config.OUTBOX_MODE, log)
  outboxPublisherRef.start()
  const orderHandler = new OrderHandler(db, nats, log, redis, eventStore, pendingDecisions)
  const messageHandler = new MessageHandler(db, redis, nats, eventStore, orderHandler, pendingDecisions, aiQuota)
  const paymentHandler = new PaymentHandler(db, nats, log, eventStore, redis, pendingDecisions, aiQuota)
  const notificationHandler = new NotificationHandler(db, log)
  const inventoryHandler = new InventoryHandler(db, eventStore)

  // Subscribe to inbound messages (WhatsApp/Instagram)
  nats.subscribe<InboundMessageEvent>(
    SUBJECTS.INBOUND_MESSAGE,
    'worker-message-handler',
    async (data) => {
      await messageHandler.handle(data)
    }
  )

  // Subscribe to order detected events (vendor confirmation tap)
  nats.subscribe<OrderDetectedEvent>(
    SUBJECTS.ORDER_DETECTED,
    'worker-order-handler',
    async (data) => {
      await orderHandler.handleDetected(data)
    }
  )

  nats.subscribe<OrderConfirmedEvent>(
    SUBJECTS.ORDER_CONFIRMED,
    'worker-order-confirmed-handler',
    async (data) => {
      if (!data.conversationId) return
      await messageHandler.markOrderCreated(data.conversationId, data.orderId)

      const record = await db.query.conversations.findFirst({
        where: eq(conversations.id, data.conversationId),
      })
      if (!record) return

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, data.merchantId),
        columns: { config: true },
      })

      const bank = (merchant?.config as Record<string, unknown>)?.bankAccount as
        | { bankName?: string; accountNumber?: string; accountName?: string }
        | undefined

      const bankText = bank
        ? `${bank.bankName ?? ''} ${bank.accountNumber ?? ''} ${bank.accountName ?? ''}`.trim()
        : 'your usual account'

      const notify: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: data.merchantId,
        to: record.customerPhone,
        channel: (record.channel as 'whatsapp' | 'instagram') ?? 'whatsapp',
        message: `Payment details: please transfer to ${bankText}. Send a screenshot once done.`,
      }

      await nats.publish(notify)
      await messageHandler.markAwaitingPayment(data.conversationId, data.orderId)
    }
  )

  // Subscribe to payment screenshots
  nats.subscribe<PaymentScreenshotReceivedEvent>(
    SUBJECTS.PAYMENT_SCREENSHOT_RECEIVED,
    'worker-payment-handler',
    async (data) => {
      await paymentHandler.handle(data)
    }
  )

  nats.subscribe<PaymentConfirmedEvent>(
    SUBJECTS.PAYMENT_CONFIRMED,
    'worker-payment-confirmed-handler',
    async (data) => {
      await db.update(orders).set({ status: 'PAID' }).where(eq(orders.id, data.orderId))

      const order = await db.query.orders.findFirst({ where: eq(orders.id, data.orderId) })
      if (!order) return

      const orderConv = order.conversationId
        ? await db.query.conversations.findFirst({ where: eq(conversations.id, order.conversationId) })
        : null

      const notify: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: data.merchantId,
        to: order.customerPhone,
        channel: (orderConv?.channel as 'whatsapp' | 'instagram') ?? 'whatsapp',
        message: `Payment received. Receipt for order ${data.orderId} — ₦${data.amount}. Thank you!`,
      }
      await nats.publish(notify)
    }
  )

  nats.subscribe<PaymentConfirmedEvent>(
    SUBJECTS.PAYMENT_CONFIRMED,
    'worker-inventory-handler',
    async (data) => {
      await inventoryHandler.handlePaymentConfirmed(data)
    }
  )

  nats.subscribe<InventoryLowEvent>(
    SUBJECTS.INVENTORY_LOW,
    'worker-inventory-low-handler',
    async (data) => {
      const snoozeKey = `inventory_low_snooze:${data.merchantId}:${data.productId}`
      const alreadySnoozed = await redis.get(snoozeKey)
      if (alreadySnoozed) return

      const product = await db.query.products.findFirst({
        where: eq(products.id, data.productId),
      })
      if (!product) return

      await redis.set(snoozeKey, '1', 'EX', 60 * 60 * 24)

      const message = `⚠️ Low stock: ${product.name} (${data.newQuantity} left). Reorder?`
      const merchantPhone = (await db.query.merchants.findFirst({
        where: eq(merchants.id, data.merchantId),
        columns: { phone: true },
      }))?.phone ?? ''
      if (merchantPhone) {
        const notify: NotificationSendEvent = {
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: data.merchantId,
          to: merchantPhone,
          channel: 'whatsapp',
          message,
        }
        await nats.publish(notify)
      }
    }
  )

  nats.subscribe<NotificationSendEvent>(
    SUBJECTS.NOTIFICATION_SEND,
    'worker-notification-handler',
    async (data) => {
      await notificationHandler.handle(data)
    }
  )

  if (config.NODE_ENV !== 'test') {
    cron.schedule('*/2 * * * *', async () => {
      // F-14: lock so concurrent worker replicas don't both pull the same
      // due retry off the zset. 90s TTL safely covers a tick.
      const acquired = await redis.set('cron:lock:mono_retries', '1', 'EX', 90, 'NX')
      if (acquired !== 'OK') return
      try {
        await paymentHandler.processMonoRetries()
      } finally {
        await redis.del('cron:lock:mono_retries')
      }
    })

    cron.schedule('0 9 * * *', async () => {      // F-14: lock so concurrent replicas don't double-send reorder reminders.
      // The `followUpSentAt` UPDATE is the underlying dedup, but the read+write
      // window between two replicas is wide enough to send twice without this.
      const acquired = await redis.set('cron:lock:reorder_reminders', '1', 'EX', 300, 'NX')
      if (acquired !== 'OK') return
      try {
      const now = new Date()
      const start = new Date(now)
      start.setDate(start.getDate() - 7)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(start.getDate() + 1)

      const dueOrders = await db.query.orders.findMany({
        where: (o, { and, eq, isNull, gte, lt }) => and(
          eq(o.status, 'PAID'),
          isNull(o.followUpSentAt),
          gte(o.createdAt, start),
          lt(o.createdAt, end)
        ),
      })

      for (const order of dueOrders) {
        const items = await db.query.orderItems.findMany({
          where: eq(orderItems.orderId, order.id),
          limit: 1,
        })
        const itemName = items[0]?.productName ?? 'your last purchase'

        const cronConv = order.conversationId
          ? await db.query.conversations.findFirst({ where: eq(conversations.id, order.conversationId) })
          : null

        const message = `Hi! It's been a week since you bought ${itemName}. Ready to reorder?`
        const notify: NotificationSendEvent = {
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: order.merchantId,
          to: order.customerPhone,
          channel: (cronConv?.channel as 'whatsapp' | 'instagram') ?? 'whatsapp',
          message,
        }
        await nats.publish(notify)

        await db.update(orders)
          .set({ followUpSentAt: new Date() })
          .where(eq(orders.id, order.id))
      }
      } finally {
        await redis.del('cron:lock:reorder_reminders')
      }
    }, {
      timezone: 'Africa/Lagos',
    })

    // Onboarding follow-up: merchants who finished onboarding 3+ days ago with no orders yet
    cron.schedule('0 10 * * *', async () => {
      const acquired = await redis.set('cron:lock:onboarding_followup', '1', 'EX', 300, 'NX')
      if (acquired !== 'OK') return
      try {
      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

      const openTasks = await db.query.agentTasks.findMany({
        where: and(
          eq(agentTasks.type, 'ONBOARDING_FOLLOWUP'),
          eq(agentTasks.status, 'OPEN'),
          lte(agentTasks.createdAt, cutoff)
        ),
      })

      for (const task of openTasks) {
        const hasOrder = await db.query.orders.findFirst({
          where: eq(orders.merchantId, task.merchantId),
        })
        if (hasOrder) {
          await db.update(agentTasks).set({ status: 'DONE' }).where(eq(agentTasks.id, task.id))
          continue
        }

        const merchant = await db.query.merchants.findFirst({
          where: eq(merchants.id, task.merchantId),
          columns: { phone: true, name: true },
        })
        if (!merchant) continue

        const template = await db.query.messageTemplates.findFirst({
          where: and(
            eq(messageTemplates.merchantId, task.merchantId),
            eq(messageTemplates.name, 'onboarding_success_followup')
          ),
        })

        const body = template?.body
          .replace('{{merchantName}}', merchant.name)
          ?? `Hi ${merchant.name}, you're all set on Mesa! Share your products with customers and orders will start coming in.`

        const notify: NotificationSendEvent = {
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: task.merchantId,
          to: merchant.phone,
          channel: 'whatsapp',
          message: body,
        }
        await nats.publish(notify)
        await db.update(agentTasks).set({ status: 'DONE' }).where(eq(agentTasks.id, task.id))

        log.info({ merchantId: task.merchantId }, 'Onboarding follow-up sent')
      }
      } finally {
        await redis.del('cron:lock:onboarding_followup')
      }
    }, {
      timezone: 'Africa/Lagos',
    })

    // Pending-decision lifecycle: nudge merchants after 2h, expire after 24h.
    // Lock the cron body via Redis so concurrent worker replicas don't double-fire.
    cron.schedule('*/15 * * * *', async () => {
      const acquired = await redis.set('cron:lock:pending_decisions', '1', 'EX', 270, 'NX')
      if (acquired !== 'OK') return

      try {
        const now = new Date()
        const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
        const pendingTypes = ['PENDING_ORDER_CONFIRMATION', 'PENDING_PAYMENT_REVIEW']

        // Expire anything OPEN for >24h.
        const expired = await db.query.agentTasks.findMany({
          where: and(
            eq(agentTasks.status, 'OPEN'),
            inArray(agentTasks.type, pendingTypes),
            lt(agentTasks.createdAt, twentyFourHoursAgo)
          ),
        })

        for (const task of expired) {
          await db.update(agentTasks).set({ status: 'EXPIRED' }).where(eq(agentTasks.id, task.id))
          const merchant = await db.query.merchants.findFirst({
            where: eq(merchants.id, task.merchantId),
            columns: { phone: true },
          })
          if (merchant) {
            const what = task.type === 'PENDING_ORDER_CONFIRMATION' ? 'order confirmation' : 'payment review'
            await nats.publish({
              subject: SUBJECTS.NOTIFICATION_SEND,
              merchantId: task.merchantId,
              to: merchant.phone,
              channel: 'whatsapp',
              message: `A pending ${what} has been open for over 24 hours and has expired. Check your dashboard if you need to recover it.`,
            } satisfies NotificationSendEvent)
          }
          // Clear any stale Redis cache so a late merchant reply doesn't act on it.
          const key = task.type === 'PENDING_ORDER_CONFIRMATION'
            ? `pending_order_by_merchant:${task.merchantId}`
            : `pending_payment_by_merchant:${task.merchantId}`
          await redis.del(key)
          log.info({ taskId: task.id, type: task.type, merchantId: task.merchantId }, 'Pending decision expired')
        }

        // Nudge anything OPEN between 2h and 24h old, once.
        const nudgeCandidates = await db.query.agentTasks.findMany({
          where: and(
            eq(agentTasks.status, 'OPEN'),
            inArray(agentTasks.type, pendingTypes),
            lt(agentTasks.createdAt, twoHoursAgo),
            gte(agentTasks.createdAt, twentyFourHoursAgo)
          ),
        })

        for (const task of nudgeCandidates) {
          const payload = (task.payload ?? {}) as Record<string, unknown>
          if (payload.nudgedAt) continue

          const merchant = await db.query.merchants.findFirst({
            where: eq(merchants.id, task.merchantId),
            columns: { phone: true },
          })
          if (merchant) {
            const what = task.type === 'PENDING_ORDER_CONFIRMATION' ? 'order' : 'payment'
            await nats.publish({
              subject: SUBJECTS.NOTIFICATION_SEND,
              merchantId: task.merchantId,
              to: merchant.phone,
              channel: 'whatsapp',
              message: `Reminder: you have a pending ${what} waiting for your reply. Please respond YES or NO, or check your dashboard.`,
            } satisfies NotificationSendEvent)
          }

          await db.update(agentTasks)
            .set({ payload: { ...payload, nudgedAt: now.toISOString() } })
            .where(eq(agentTasks.id, task.id))
          log.info({ taskId: task.id, type: task.type, merchantId: task.merchantId }, 'Pending decision nudged')
        }
      } finally {
        await redis.del('cron:lock:pending_decisions')
      }
    }, {
      timezone: 'Africa/Lagos',
    })
  }

  app.get('/health', async (_req, reply) => {
    try {
      await redis.ping()
      await db.execute(sql`select 1`)
      const natsOk = nats.isConnected
      if (!natsOk) {
        return reply.status(503).send({ status: 'degraded', service: 'worker', nats: 'disconnected' })
      }
      return { status: 'ok', service: 'worker' }
    } catch (err) {
      return reply.status(503).send({ status: 'degraded', service: 'worker', error: 'dependency_unavailable' })
    }
  })

  app.get('/ready', async (_req, reply) => {
    try {
      await redis.ping()
      await db.execute(sql`select 1`)
      const natsOk = nats.isConnected
      if (!natsOk) {
        return reply.status(503).send({ status: 'not_ready', service: 'worker', nats: 'disconnected' })
      }
      return { status: 'ready', service: 'worker' }
    } catch (err) {
      return reply.status(503).send({ status: 'not_ready', service: 'worker', error: 'dependency_unavailable' })
    }
  })

  await app.listen({ port: config.WORKER_PORT, host: '0.0.0.0' })
  log.info({ service: 'worker', port: config.WORKER_PORT }, 'Worker running — consuming NATS events')
}

async function shutdown() {
  if (outboxPublisherRef) await outboxPublisherRef.stop()
  if (app) {
    await app.close()
  }
  await closeDb()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch(err => {
  if (config.SENTRY_DSN) {
    Sentry.captureException(err, { tags: { service: 'worker' } })
  }
  log.error({ service: 'worker', err }, 'Worker failed to start')
  process.exit(1)
})
