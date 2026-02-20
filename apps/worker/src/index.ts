import Redis from 'ioredis'
import { config } from '@mesa/config'
import { getDb, closeDb } from '@mesa/db'
import { MesaNatsClient } from '@mesa/nats'
import { SUBJECTS, WhatsAppInboundEvent, PaymentScreenshotReceivedEvent, OrderDetectedEvent } from '@mesa/types'
import { MessageHandler } from './handlers/message.handler'
import { PaymentHandler } from './handlers/payment.handler'
import { OrderHandler } from './handlers/order.handler'

async function start() {
  const db = getDb(config.DATABASE_URL)
  const redis = new Redis(config.REDIS_URL)
  const nats = new MesaNatsClient()

  await nats.connect(config.NATS_URL)

  const messageHandler = new MessageHandler(db, redis, nats)
  const paymentHandler = new PaymentHandler(db, nats)
  const orderHandler = new OrderHandler(db, nats)

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

  console.log('Worker running — consuming NATS events')
}

async function shutdown() {
  await closeDb()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch(err => {
  console.error('Worker failed to start:', err)
  process.exit(1)
})