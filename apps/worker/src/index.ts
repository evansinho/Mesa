import './otel'
import Redis from 'ioredis'
import { config } from '@mesa/config'
import { getDb, closeDb } from '@mesa/db'
import { MesaNatsClient } from '@mesa/nats'
import { SUBJECTS, WhatsAppInboundEvent, PaymentScreenshotReceivedEvent, OrderDetectedEvent, NotificationSendEvent, OrderConfirmedEvent, PaymentConfirmedEvent, InventoryLowEvent } from '@mesa/types'
import { orders, products, orderItems, conversations, merchants } from '@mesa/db'
import { eq } from 'drizzle-orm'
import { MessageHandler } from './handlers/message.handler'
import { PaymentHandler } from './handlers/payment.handler'
import { OrderHandler } from './handlers/order.handler'
import { NotificationHandler } from './handlers/notification.handler'
import { InventoryHandler } from './handlers/inventory.handler'
import * as Sentry from '@sentry/node'
import Fastify, { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { EventStore } from './events/event-store'
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

async function start() {
  const db = getDb(config.DATABASE_URL)
  const redis = new Redis(config.REDIS_URL)
  const nats = new MesaNatsClient()
  app = Fastify({ logger: false })

  await nats.connect(config.NATS_URL)

  const eventStore = new EventStore(db)
  const orderHandler = new OrderHandler(db, nats, log, redis, eventStore)
  const messageHandler = new MessageHandler(db, redis, nats, eventStore, orderHandler)
  const paymentHandler = new PaymentHandler(db, nats, log, eventStore, redis)
  const notificationHandler = new NotificationHandler(nats)
  const inventoryHandler = new InventoryHandler(db, nats)

  // Subscribe to inbound WhatsApp messages
  nats.subscribe<WhatsAppInboundEvent>(
    SUBJECTS.WHATSAPP_INBOUND,
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
        toPhone: record.customerPhone,
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

      const notify: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: data.merchantId,
        toPhone: order.customerPhone,
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
      const notify: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: data.merchantId,
        toPhone: (await db.query.merchants.findFirst({
          where: eq(merchants.id, data.merchantId),
          columns: { phone: true },
        }))?.phone ?? '',
        message,
      }
      if (notify.toPhone) {
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
    cron.schedule('0 9 * * *', async () => {
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

        const message = `Hi! It's been a week since you bought ${itemName}. Ready to reorder?`
        const notify: NotificationSendEvent = {
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: order.merchantId,
          toPhone: order.customerPhone,
          message,
        }
        await nats.publish(notify)

        await db.update(orders)
          .set({ followUpSentAt: new Date() })
          .where(eq(orders.id, order.id))
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
