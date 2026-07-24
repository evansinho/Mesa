import './otel'
import Redis from 'ioredis'
import { config } from '@mesa/config'
import { isWabaSubscribed, subscribeWabaApp } from '@mesa/whatsapp'
import { getDb, closeDb } from '@mesa/db'
import { MesaNatsClient } from '@mesa/nats'
import {
  SUBJECTS,
  InboundMessageEvent,
  PaymentScreenshotReceivedEvent,
  OrderDetectedEvent,
  NotificationSendEvent,
  OrderConfirmedEvent,
  PaymentConfirmedEvent,
  InventoryLowEvent,
  WhatsAppContactSyncEvent,
  WhatsAppHistorySyncEvent,
  WhatsAppMessageEchoEvent,
} from '@mesa/types'
import { orders, products, orderItems, conversations, merchants, agentTasks, messageTemplates, billingEvents } from '@mesa/db'
import { eq, and, lte, lt, gte, inArray } from 'drizzle-orm'
import { MessageHandler } from './handlers/message.handler'
import { PaymentHandler, buildPaymentReviewTemplate, type PaymentReviewReason } from './handlers/payment.handler'
import { notifyMerchantOnSourceChannel } from './handlers/notify-merchant'
import { OrderHandler } from './handlers/order.handler'
import { NotificationHandler } from './handlers/notification.handler'
import { InventoryHandler } from './handlers/inventory.handler'
import { PendingDecisions } from './handlers/pending-decisions'
import { FulfilmentHandler } from './handlers/fulfilment.handler'
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
const cronJobs: ReturnType<typeof cron.schedule>[] = []

type OrderItemSummary = {
  productName: string
  quantity: number
  agreedPrice: string
}

function money(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return `₦${value}`
  return `₦${numeric.toLocaleString()}`
}

function shortOrderRef(orderId: string): string {
  return orderId.slice(-8).toUpperCase()
}

function formatOrderItems(items: OrderItemSummary[]): string {
  if (items.length === 0) return 'Order items unavailable'
  return items
    .map(item => `${item.quantity} × ${item.productName} — ${money(item.agreedPrice)}`)
    .join('\n')
}

function formatReceiptDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  }).format(date)
}

async function start() {
  const db = getDb(config.DATABASE_URL)
  const redis = new Redis(config.REDIS_URL)
  const nats = new MesaNatsClient()
  app = Fastify({ logger: false })

  let _redisPingOk = true
  let _redisPingAt = 0
  async function cachedRedisPing() {
    if (Date.now() - _redisPingAt < 30_000) return _redisPingOk
    try { await redis.ping(); _redisPingOk = true }
    catch { _redisPingOk = false }
    _redisPingAt = Date.now()
    return _redisPingOk
  }

  await nats.connect(config.NATS_URL)

  const eventStore = new EventStore(db, nats, config.OUTBOX_MODE)
  const pendingDecisions = new PendingDecisions(db, redis)
  const aiQuota = new AiQuota(db, redis, log)
  outboxPublisherRef = new OutboxPublisher(db, nats, redis, config.OUTBOX_MODE, log)
  outboxPublisherRef.start()
  const orderHandler = new OrderHandler(db, nats, log, redis, eventStore, pendingDecisions)
  const paymentHandler = new PaymentHandler(db, nats, log, eventStore, redis, pendingDecisions, aiQuota)
  const notificationHandler = new NotificationHandler(db, log, redis)
  const inventoryHandler = new InventoryHandler(db, eventStore)
  const fulfilmentHandler = new FulfilmentHandler(db, nats, pendingDecisions)
  const messageHandler = new MessageHandler(db, redis, nats, eventStore, orderHandler, pendingDecisions, aiQuota, fulfilmentHandler)

  // Subscribe to inbound messages (WhatsApp/Instagram)
  nats.subscribe<InboundMessageEvent>(
    SUBJECTS.INBOUND_MESSAGE,
    'worker-message-handler',
    async (data) => {
      await messageHandler.handle(data)
    }
  )

  nats.subscribe<WhatsAppMessageEchoEvent>(
    SUBJECTS.WHATSAPP_MESSAGE_ECHO,
    'worker-whatsapp-message-echo-handler',
    async (data) => {
      await messageHandler.handleMessageEcho(data)
    }
  )

  nats.subscribe<WhatsAppHistorySyncEvent>(
    SUBJECTS.WHATSAPP_HISTORY_SYNC,
    'worker-whatsapp-history-sync-handler',
    async (data) => {
      await messageHandler.handleHistorySync(data)
    }
  )

  nats.subscribe<WhatsAppContactSyncEvent>(
    SUBJECTS.WHATSAPP_CONTACT_SYNC,
    'worker-whatsapp-contact-sync-handler',
    async (data) => {
      await messageHandler.handleContactSync(data)
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
      if (data.conversationId) {
        await messageHandler.markOrderCreated(data.conversationId, data.orderId)
      }

      const order = await db.query.orders.findFirst({
        where: eq(orders.id, data.orderId),
      })
      if (!order) return

      const record = order.conversationId
        ? await db.query.conversations.findFirst({ where: eq(conversations.id, order.conversationId) })
        : null

      const items = await db.query.orderItems.findMany({
        where: eq(orderItems.orderId, data.orderId),
        columns: { productName: true, quantity: true, agreedPrice: true },
      })

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, data.merchantId),
        columns: { name: true, config: true },
      })

      const bank = (merchant?.config as Record<string, unknown>)?.bankAccount as
        | { bankName?: string; accountNumber?: string; accountName?: string }
        | undefined

      const bankText = bank
        ? `${bank.bankName ?? ''} · ${bank.accountNumber ?? ''} · ${bank.accountName ?? ''}`.trim()
        : 'your usual account'

      const notify: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: data.merchantId,
        to: order.customerPhone,
        channel: (record?.channel as 'whatsapp' | 'instagram' | undefined) ?? 'whatsapp',
        message: [
          'Order confirmed ✓',
          '',
          merchant?.name ?? 'Your order',
          '',
          formatOrderItems(items),
          '',
          `Total: ${money(order.total)}`,
          '',
          'Pay here:',
          bankText,
          '',
          'After paying, send your transfer receipt here and I will confirm automatically. Or just reply DONE if you prefer.',
        ].join('\n'),
      }

      await nats.publish(notify)
      if (data.conversationId) {
        await messageHandler.markAwaitingPayment(data.conversationId, data.orderId)
      }
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
      const items = await db.query.orderItems.findMany({
        where: eq(orderItems.orderId, data.orderId),
        columns: { productName: true, quantity: true, agreedPrice: true },
      })
      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, data.merchantId),
        columns: { name: true },
      })

      const notify: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: data.merchantId,
        to: order.customerPhone,
        channel: (orderConv?.channel as 'whatsapp' | 'instagram') ?? 'whatsapp',
        message: [
          'Payment received ✓',
          '',
          merchant?.name ?? 'Mesa',
          `Ref: ${shortOrderRef(data.orderId)}`,
          formatReceiptDate(),
          '',
          formatOrderItems(items),
          '',
          `Total paid: ${money(data.amount)}`,
          '',
          'Thank you!',
        ].join('\n'),
      }
      await nats.publish(notify)
      if (order.conversationId) {
        await messageHandler.markPaymentVerified(order.conversationId, data.orderId, data.amount, data.reference)
      }
      await fulfilmentHandler.startAfterPayment(data)
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
    // Meta occasionally drops the app↔WABA subscription silently, killing ALL
    // webhook delivery with no error anywhere (observed 2026-07-10). Check
    // hourly and self-heal.
    cronJobs.push(cron.schedule('20 * * * *', async () => {
      if (!config.WHATSAPP_WABA_ID) return
      const acquired = await redis.set('cron:lock:waba_subscription', '1', 'EX', 300, 'NX')
      if (acquired !== 'OK') return
      try {
        if (await isWabaSubscribed(config.WHATSAPP_WABA_ID)) return
        log.error({ wabaId: config.WHATSAPP_WABA_ID }, 'WABA webhook subscription missing — resubscribing')
        await subscribeWabaApp(config.WHATSAPP_WABA_ID)
        const healed = await isWabaSubscribed(config.WHATSAPP_WABA_ID)
        if (healed) {
          log.warn({ wabaId: config.WHATSAPP_WABA_ID }, 'WABA webhook subscription restored automatically')
        } else {
          log.error({ wabaId: config.WHATSAPP_WABA_ID }, 'WABA resubscribe FAILED — webhooks are down, manual action needed')
          if (config.SENTRY_DSN) {
            Sentry.captureMessage('WABA webhook resubscribe failed — inbound delivery is down', 'fatal')
          }
        }
      } catch (err) {
        log.error({ err }, 'WABA subscription check failed')
      } finally {
        await redis.del('cron:lock:waba_subscription')
      }
    }))

    cronJobs.push(cron.schedule('*/30 * * * *', async () => {
      // F-14: lock so concurrent worker replicas don't both pull the same
      // due retry off the zset. 90s TTL safely covers a tick.
      const acquired = await redis.set('cron:lock:mono_retries', '1', 'EX', 90, 'NX')
      if (acquired !== 'OK') return
      try {
        await paymentHandler.processMonoRetries()
      } finally {
        await redis.del('cron:lock:mono_retries')
      }
    }))

    cronJobs.push(cron.schedule('0 9 * * *', async () => {
      const acquired = await redis.set('cron:lock:trial_warnings', '1', 'EX', 300, 'NX')
      if (acquired !== 'OK') return
      try {
        const now = new Date()
        const start = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        const end = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
        const warningDate = now.toISOString().slice(0, 10)

        const expiring = await db.query.merchants.findMany({
          where: and(
            eq(merchants.subscriptionStatus, 'trialing'),
            gte(merchants.trialEndsAt, start),
            lte(merchants.trialEndsAt, end),
          ),
          columns: { id: true, phone: true, trialEndsAt: true },
        })

        for (const merchant of expiring) {
          const eventKey = `trial_warning:${merchant.id}:${warningDate}`
          const existing = await db.query.billingEvents.findFirst({
            where: eq(billingEvents.eventKey, eventKey),
          })
          if (existing) continue

          const daysLeft = Math.max(
            1,
            Math.ceil(((merchant.trialEndsAt ?? now).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
          )
          await nats.publish({
            subject: SUBJECTS.NOTIFICATION_SEND,
            merchantId: merchant.id,
            to: merchant.phone,
            channel: 'whatsapp',
            message: `Your Mesa free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Subscribe now to keep order automation running:\n\n${config.DASHBOARD_URL}/billing`,
          } satisfies NotificationSendEvent)
          await db.insert(billingEvents).values({
            merchantId: merchant.id,
            type: 'trial_warning_sent',
            eventKey,
            metadata: { daysLeft },
          })
        }
      } finally {
        await redis.del('cron:lock:trial_warnings')
      }
    }, {
      timezone: 'Africa/Lagos',
    }))

    cronJobs.push(cron.schedule('0 8 * * *', async () => {
      const acquired = await redis.set('cron:lock:trial_expiry', '1', 'EX', 300, 'NX')
      if (acquired !== 'OK') return
      try {
        const now = new Date()
        const expired = await db.query.merchants.findMany({
          where: and(
            eq(merchants.subscriptionStatus, 'trialing'),
            lte(merchants.trialEndsAt, now),
          ),
          columns: { id: true, phone: true },
        })

        for (const merchant of expired) {
          await db.update(merchants)
            .set({ subscriptionStatus: 'expired', updatedAt: new Date() })
            .where(eq(merchants.id, merchant.id))
          await redis.del(`subscription_gate:${merchant.id}`)
          await nats.publish({
            subject: SUBJECTS.NOTIFICATION_SEND,
            merchantId: merchant.id,
            to: merchant.phone,
            channel: 'whatsapp',
            message: `Your Mesa free trial has ended and customer order automation is now paused. Subscribe to reactivate:\n\n${config.DASHBOARD_URL}/billing`,
          } satisfies NotificationSendEvent)
          await db.insert(billingEvents).values({
            merchantId: merchant.id,
            type: 'trial_expired',
            eventKey: `trial_expired:${merchant.id}`,
            metadata: {},
          }).onConflictDoNothing()
        }
      } finally {
        await redis.del('cron:lock:trial_expiry')
      }
    }, {
      timezone: 'Africa/Lagos',
    }))

    cronJobs.push(cron.schedule('0 9 * * *', async () => {
      // F-14: lock so concurrent replicas don't double-send reorder reminders.
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

        if (dueOrders.length > 0) {
          const orderIds = dueOrders.map(o => o.id)
          const convIds = dueOrders.map(o => o.conversationId).filter((id): id is string => id != null)

          const [allItems, allConvs] = await Promise.all([
            db.query.orderItems.findMany({
              where: inArray(orderItems.orderId, orderIds),
              columns: { orderId: true, productName: true },
            }),
            convIds.length > 0
              ? db.query.conversations.findMany({
                  where: inArray(conversations.id, convIds),
                  columns: { id: true, channel: true },
                })
              : Promise.resolve([]),
          ])

          const firstItemByOrder = new Map<string, string>()
          for (const item of allItems) {
            if (!firstItemByOrder.has(item.orderId)) {
              firstItemByOrder.set(item.orderId, item.productName ?? 'your last purchase')
            }
          }
          const convMap = new Map(allConvs.map(c => [c.id, c]))

          for (const order of dueOrders) {
            // An active customer must not get a canned nudge: skip anyone who
            // has ordered again since, or talked to the merchant in the last
            // 3 days (they may be mid-negotiation). Mark handled either way.
            const newerOrder = await db.query.orders.findFirst({
              where: (o, { and: andOp, eq: eqOp, gt, ne }) => andOp(
                eqOp(o.merchantId, order.merchantId),
                eqOp(o.customerPhone, order.customerPhone),
                gt(o.createdAt, order.createdAt),
                ne(o.status, 'CANCELLED'),
              ),
              columns: { id: true },
            })
            const convRow = order.conversationId
              ? await db.query.conversations.findFirst({
                  where: eq(conversations.id, order.conversationId),
                  columns: { context: true },
                })
              : null
            const lastMessageAt = (convRow?.context as { lastMessageAt?: string } | null)?.lastMessageAt
            const activeRecently = lastMessageAt
              ? Date.now() - new Date(lastMessageAt).getTime() < 3 * 24 * 60 * 60 * 1000
              : false

            if (newerOrder || activeRecently) {
              await db.update(orders)
                .set({ followUpSentAt: new Date() })
                .where(eq(orders.id, order.id))
              continue
            }

            const itemName = firstItemByOrder.get(order.id) ?? 'your last purchase'
            const cronConv = order.conversationId ? convMap.get(order.conversationId) : null

            const notify: NotificationSendEvent = {
              subject: SUBJECTS.NOTIFICATION_SEND,
              merchantId: order.merchantId,
              to: order.customerPhone,
              channel: (cronConv?.channel as 'whatsapp' | 'instagram') ?? 'whatsapp',
              message: `Hi! It's been a week since you bought ${itemName}. Ready to reorder?`,
            }
            await nats.publish(notify)

            await db.update(orders)
              .set({ followUpSentAt: new Date() })
              .where(eq(orders.id, order.id))
          }
        }
      } finally {
        await redis.del('cron:lock:reorder_reminders')
      }
    }, {
      timezone: 'Africa/Lagos',
    }))

    // Onboarding follow-up: merchants who finished onboarding 3+ days ago with no orders yet
    cronJobs.push(cron.schedule('0 10 * * *', async () => {
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

        if (openTasks.length === 0) return

        const allMerchantIds = [...new Set(openTasks.map(t => t.merchantId))]

        const ordersExist = await db.query.orders.findMany({
          where: inArray(orders.merchantId, allMerchantIds),
          columns: { merchantId: true },
        })
        const merchantsWithOrders = new Set(ordersExist.map(o => o.merchantId))

        const tasksDone = openTasks.filter(t => merchantsWithOrders.has(t.merchantId))
        if (tasksDone.length > 0) {
          await db.update(agentTasks)
            .set({ status: 'DONE' })
            .where(inArray(agentTasks.id, tasksDone.map(t => t.id)))
        }

        const tasksNeedingFollowup = openTasks.filter(t => !merchantsWithOrders.has(t.merchantId))
        if (tasksNeedingFollowup.length === 0) return

        const followupMerchantIds = [...new Set(tasksNeedingFollowup.map(t => t.merchantId))]

        const [merchantsList, templatesList] = await Promise.all([
          db.query.merchants.findMany({
            where: inArray(merchants.id, followupMerchantIds),
            columns: { id: true, phone: true, name: true },
          }),
          db.query.messageTemplates.findMany({
            where: and(
              inArray(messageTemplates.merchantId, followupMerchantIds),
              eq(messageTemplates.name, 'onboarding_success_followup')
            ),
          }),
        ])

        const merchantMap = new Map(merchantsList.map(m => [m.id, m]))
        const templateMap = new Map(templatesList.map(t => [t.merchantId, t]))

        for (const task of tasksNeedingFollowup) {
          const merchant = merchantMap.get(task.merchantId)
          if (!merchant) continue

          const template = templateMap.get(task.merchantId)
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
    }))

    cronJobs.push(cron.schedule('*/30 * * * *', async () => {
      const acquired = await redis.set('cron:lock:payment_check_again', '1', 'EX', 270, 'NX')
      if (acquired !== 'OK') return
      try {
        const now = new Date()
        const openPaymentTasks = await db.query.agentTasks.findMany({
          where: and(
            eq(agentTasks.type, 'PENDING_PAYMENT_REVIEW'),
            eq(agentTasks.status, 'OPEN'),
          ),
        })

        const dueTasks = openPaymentTasks.filter(task => {
          const payload = task.payload as Record<string, unknown>
          if (payload.remindersStopped === true) return false
          const nextReminderAt = typeof payload.nextReminderAt === 'string'
            ? new Date(payload.nextReminderAt)
            : null
          return nextReminderAt != null && nextReminderAt <= now
        })
        if (dueTasks.length === 0) return

        const merchantIds = [...new Set(dueTasks.map(t => t.merchantId))]
        const merchantRows = await db.query.merchants.findMany({
          where: inArray(merchants.id, merchantIds),
          columns: { id: true, phone: true },
        })
        const merchantMap = new Map(merchantRows.map(m => [m.id, m]))

        // Resend the exact same prompt the merchant saw the first time
        // (mesa_payment_needs_confirmation_v2) rather than a separate
        // "check again" template — a second template maintained on its own
        // previously drifted from what was actually approved on Meta and
        // got rejected outright (#132018 button-type mismatch).
        for (const task of dueTasks) {
          const payload = task.payload as Record<string, unknown>
          const merchant = merchantMap.get(task.merchantId)
          if (!merchant) continue

          const orderId = typeof payload.orderId === 'string' ? payload.orderId : ''
          if (!orderId) continue
          const order = await db.query.orders.findFirst({
            where: eq(orders.id, orderId),
            columns: { total: true, customerName: true, customerPhone: true, conversationId: true },
          })
          const expected = typeof payload.expected === 'number'
            ? payload.expected
            : order?.total ? parseFloat(order.total) : undefined
          const received = typeof payload.received === 'number' ? payload.received : undefined
          const reason = typeof payload.reason === 'string' ? payload.reason as PaymentReviewReason : 'mono_required'
          const actionUrl = typeof payload.actionUrl === 'string' ? payload.actionUrl : `${config.DASHBOARD_URL}/actions/payment`
          const conv = order?.conversationId
            ? await db.query.conversations.findFirst({ where: eq(conversations.id, order.conversationId), columns: { channel: true } })
            : undefined

          await notifyMerchantOnSourceChannel(db, nats, {
            merchantId: task.merchantId,
            sourceChannel: conv?.channel ?? 'whatsapp',
            actionUrl,
            template: buildPaymentReviewTemplate({
              orderId,
              customerLabel: order?.customerName ?? order?.customerPhone ?? 'Customer',
              expected,
              received,
              reason,
            }),
          })

          await db.update(agentTasks)
            .set({
              payload: {
                ...payload,
                nextReminderAt: undefined,
                lastReminderSentAt: now.toISOString(),
              },
            })
            .where(eq(agentTasks.id, task.id))
        }
      } finally {
        await redis.del('cron:lock:payment_check_again')
      }
    }, {
      timezone: 'Africa/Lagos',
    }))

    // Pending-decision lifecycle: nudge merchants after 2h, expire after 24h.
    // Lock the cron body via Redis so concurrent worker replicas don't double-fire.
    cronJobs.push(cron.schedule('0 * * * *', async () => {
      const acquired = await redis.set('cron:lock:pending_decisions', '1', 'EX', 270, 'NX')
      if (acquired !== 'OK') return

      try {
        const now = new Date()
        const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
        const pendingTypes = ['PENDING_ORDER_CONFIRMATION', 'PENDING_PAYMENT_REVIEW', 'PENDING_PRODUCT_MEDIA_CONFIRMATION']
        const pendingDecisionLabel = (type: string): string => {
          if (type === 'PENDING_ORDER_CONFIRMATION') return 'order confirmation'
          if (type === 'PENDING_PAYMENT_REVIEW') return 'payment review'
          if (type === 'PENDING_PRODUCT_MEDIA_CONFIRMATION') return 'product media confirmation'
          return 'pending decision'
        }
        const pendingDecisionCacheKey = (type: string, merchantId: string): string => {
          if (type === 'PENDING_ORDER_CONFIRMATION') return `pending_order_by_merchant:${merchantId}`
          if (type === 'PENDING_PAYMENT_REVIEW') return `pending_payment_by_merchant:${merchantId}`
          if (type === 'PENDING_PRODUCT_MEDIA_CONFIRMATION') return `pending_product_media_by_merchant:${merchantId}`
          return `pending_fulfilment_by_merchant:${merchantId}`
        }

        // Expire anything OPEN for >24h.
        const expired = await db.query.agentTasks.findMany({
          where: and(
            eq(agentTasks.status, 'OPEN'),
            inArray(agentTasks.type, pendingTypes),
            lt(agentTasks.createdAt, twentyFourHoursAgo)
          ),
        })

        if (expired.length > 0) {
          const expiredMerchantIds = [...new Set(expired.map(t => t.merchantId))]
          const expiredMerchants = await db.query.merchants.findMany({
            where: inArray(merchants.id, expiredMerchantIds),
            columns: { id: true, phone: true },
          })
          const expiredMerchantMap = new Map(expiredMerchants.map(m => [m.id, m]))

          await db.update(agentTasks)
            .set({ status: 'EXPIRED' })
            .where(inArray(agentTasks.id, expired.map(t => t.id)))

          for (const task of expired) {
            const merchant = expiredMerchantMap.get(task.merchantId)
            if (merchant) {
              const what = pendingDecisionLabel(task.type)
              await nats.publish({
                subject: SUBJECTS.NOTIFICATION_SEND,
                merchantId: task.merchantId,
                to: merchant.phone,
                channel: 'whatsapp',
                message: `A pending ${what} has been open for over 24 hours and has expired. Check your dashboard if you need to recover it.`,
              } satisfies NotificationSendEvent)
            }
            // Clear any stale Redis cache so a late merchant reply doesn't act on it.
            await redis.del(pendingDecisionCacheKey(task.type, task.merchantId))
            log.info({ taskId: task.id, type: task.type, merchantId: task.merchantId }, 'Pending decision expired')
          }
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

        if (nudgeCandidates.length > 0) {
          const nudgeMerchantIds = [...new Set(nudgeCandidates.map(t => t.merchantId))]
          const nudgeMerchants = await db.query.merchants.findMany({
            where: inArray(merchants.id, nudgeMerchantIds),
            columns: { id: true, phone: true },
          })
          const nudgeMerchantMap = new Map(nudgeMerchants.map(m => [m.id, m]))

          for (const task of nudgeCandidates) {
            const payload = (task.payload ?? {}) as Record<string, unknown>
            if (payload.nudgedAt) continue

            const merchant = nudgeMerchantMap.get(task.merchantId)
            if (merchant) {
              const what = pendingDecisionLabel(task.type)
              await nats.publish({
                subject: SUBJECTS.NOTIFICATION_SEND,
                merchantId: task.merchantId,
                to: merchant.phone,
                channel: 'whatsapp',
                message: `Reminder: you have a pending ${what} waiting in Mesa. Use the WhatsApp buttons or open Mesa to continue.`,
              } satisfies NotificationSendEvent)
            }

            await db.update(agentTasks)
              .set({ payload: { ...payload, nudgedAt: now.toISOString() } })
              .where(eq(agentTasks.id, task.id))
            log.info({ taskId: task.id, type: task.type, merchantId: task.merchantId }, 'Pending decision nudged')
          }
        }
      } finally {
        await redis.del('cron:lock:pending_decisions')
      }
    }, {
      timezone: 'Africa/Lagos',
    }))
  }

  // DB check cached for 60 s — same reason as API: prevent Neon wake-up on every platform ping.
  let dbOk = true
  let dbCheckedAt = 0
  async function cachedDbPing(): Promise<boolean> {
    if (Date.now() - dbCheckedAt < 60_000) return dbOk
    try {
      await db.execute(sql`select 1`)
      dbOk = true
    } catch {
      dbOk = false
    }
    dbCheckedAt = Date.now()
    return dbOk
  }

  app.get('/health', async (_req, reply) => {
    const [redisOk, dbOkNow] = await Promise.all([cachedRedisPing(), cachedDbPing()])
    if (!redisOk || !dbOkNow) return reply.status(503).send({ status: 'degraded', service: 'worker', error: 'dependency_unavailable' })
    if (!nats.isConnected) return reply.status(503).send({ status: 'degraded', service: 'worker', nats: 'disconnected' })
    return { status: 'ok', service: 'worker' }
  })

  app.get('/ready', async (_req, reply) => {
    const [redisOk, dbOkNow] = await Promise.all([cachedRedisPing(), cachedDbPing()])
    if (!redisOk || !dbOkNow) return reply.status(503).send({ status: 'not_ready', service: 'worker', error: 'dependency_unavailable' })
    if (!nats.isConnected) return reply.status(503).send({ status: 'not_ready', service: 'worker', nats: 'disconnected' })
    return { status: 'ready', service: 'worker' }
  })

  app.get<{ Params: { id: string } }>('/debug/commerce/:id', async (req, reply) => {
    if (req.headers['x-mesa-api-key'] !== config.INTERNAL_API_KEY) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const record = await db.query.conversations.findFirst({
      where: eq(conversations.id, req.params.id),
      columns: { id: true, merchantId: true, customerPhone: true, state: true, context: true, updatedAt: true },
    })
    if (!record) return reply.status(404).send({ error: 'Not found' })

    const context = record.context as {
      botRuntime?: {
        checkoutStage?: string
        cart?: unknown[]
        activeItemKey?: string
        lastBotDecisionKey?: string
        escalationReason?: string
        automationPausedUntil?: string
      }
      checkoutStage?: string
      currentItems?: unknown[]
      orderId?: string
      awaitingOrderConfirmation?: boolean
      lastQuotedPrice?: number
      agreedPrice?: number
    }

    return {
      conversation: {
        id: record.id,
        merchantId: record.merchantId,
        customerPhone: record.customerPhone,
        state: record.state,
        updatedAt: record.updatedAt,
      },
      commerce: {
        checkoutStage: context.botRuntime?.checkoutStage ?? context.checkoutStage,
        cart: context.botRuntime?.cart ?? context.currentItems ?? [],
        activeItemKey: context.botRuntime?.activeItemKey,
        lastDecision: context.botRuntime?.lastBotDecisionKey,
        handoffReason: context.botRuntime?.escalationReason,
        automationPausedUntil: context.botRuntime?.automationPausedUntil,
        orderId: context.orderId,
        awaitingCartConfirmation: context.awaitingOrderConfirmation,
        lastQuoteTotal: context.lastQuotedPrice ?? context.agreedPrice,
      },
    }
  })

  await app.listen({ port: config.WORKER_PORT, host: '0.0.0.0' })
  log.info({ service: 'worker', port: config.WORKER_PORT }, 'Worker running — consuming NATS events')
}

async function shutdown() {
  for (const job of cronJobs) job.stop()
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
