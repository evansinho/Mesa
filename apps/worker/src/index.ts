import './otel'
import Redis from 'ioredis'
import { config } from '@mesa/config'
import { getDb, closeDb } from '@mesa/db'
import { MesaNatsClient } from '@mesa/nats'
import { SUBJECTS, WhatsAppInboundEvent, PaymentScreenshotReceivedEvent, OrderDetectedEvent } from '@mesa/types'
import { MessageHandler } from './handlers/message.handler'
import { PaymentHandler } from './handlers/payment.handler'
import { OrderHandler } from './handlers/order.handler'
import * as Sentry from '@sentry/node'
import Fastify, { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { EventStore } from './events/event-store'

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
  const messageHandler = new MessageHandler(db, redis, nats, eventStore)
  const paymentHandler = new PaymentHandler(db, nats, log, eventStore)
  const orderHandler = new OrderHandler(db, nats, log, eventStore)

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

  // Subscribe to payment screenshots
  nats.subscribe<PaymentScreenshotReceivedEvent>(
    SUBJECTS.PAYMENT_SCREENSHOT_RECEIVED,
    'worker-payment-handler',
    async (data) => {
      await paymentHandler.handle(data)
    }
  )

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
