// Mock the AI module before the handler is imported.
const analyseMock = jest.fn()
jest.mock('@mesa/ai', () => ({
  analyseMessage: (...args: unknown[]) => analyseMock(...args),
}))

// Mock the WhatsApp media downloader — not needed in any of these tests.
jest.mock('@mesa/whatsapp', () => ({
  downloadMedia: jest.fn(),
}))

jest.mock('../../src/storage/r2', () => ({
  uploadScreenshot: jest.fn(),
}))

import { eq } from 'drizzle-orm'
import { downloadMedia } from '@mesa/whatsapp'
import { conversations, fulfilments, merchants, orderItems, orders, payments } from '@mesa/db'
import { MessageHandler } from '../../src/handlers/message.handler'
import { OrderHandler } from '../../src/handlers/order.handler'
import { PendingDecisions } from '../../src/handlers/pending-decisions'
import { AiQuota, lagosDateKey } from '../../src/ai/quota'
import { FulfilmentHandler } from '../../src/handlers/fulfilment.handler'
import { uploadScreenshot } from '../../src/storage/r2'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation, createProduct, createOrder, createMerchantChannel } from '@test-helpers/factories'

setupIntegration()

beforeEach(() => {
  analyseMock.mockReset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

function build() {
  const db = getTestDb()
  const redis = getTestRedis()
  const natsPublish = jest.fn().mockResolvedValue(undefined)
  const nats = { publish: natsPublish } as never
  const pending = new PendingDecisions(db, redis)
  const aiQuota = new AiQuota(db, redis)
  const orderHandler = new OrderHandler(db, nats, console, redis, undefined, pending)
  const fulfilmentHandler = new FulfilmentHandler(db, nats, pending)
  const handler = new MessageHandler(db, redis, nats, undefined, orderHandler, pending, aiQuota, fulfilmentHandler)
  return { handler, natsPublish, db, redis, pending, fulfilmentHandler }
}

const MERCHANT_PHONE = '+2348012345678'
const CUSTOMER_PHONE = '+2348099998888'
const MESA_PHONE = '+2348067092426'

function inboundText(merchantId: string, fromPhone: string, text: string) {
  return {
    subject: 'mesa.inbound.message' as const,
    merchantId,
    message: {
      channel: 'whatsapp' as const,
      channelAccountId: 'pn_x',
      customerId: fromPhone,
      messageId: `msg_${Date.now()}_${Math.random()}`,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text' as const,
      text,
    },
  }
}

function inboundMedia(merchantId: string, fromPhone: string, type: 'image' | 'document') {
  return {
    subject: 'mesa.inbound.message' as const,
    merchantId,
    message: {
      channel: 'whatsapp' as const,
      channelAccountId: 'pn_x',
      customerId: fromPhone,
      messageId: `media_${Date.now()}_${Math.random()}`,
      timestamp: Math.floor(Date.now() / 1000),
      type,
      mediaId: 'media_123',
      mimeType: type === 'document' ? 'application/pdf' : 'image/png',
    },
  }
}

function messageEcho(merchantId: string, toPhone: string, text: string) {
  return {
    subject: 'mesa.whatsapp.message_echo' as const,
    merchantId,
    message: {
      channel: 'whatsapp' as const,
      channelAccountId: 'pn_x',
      customerId: toPhone,
      messageId: `echo_${Date.now()}_${Math.random()}`,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text' as const,
      text,
    },
  }
}

describe('MessageHandler — merchant reply branches (F-3 integration)', () => {
  it('merchant YES confirms a pending order — F-3 regression', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { bot: { enabled: false } } })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'rice', quantity: 3 }],
      agreedTotal: 5000,
      prompt: 'Order detected — Reply YES.',
    })

    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'yes'))

    const createdOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(5000)

    // Pending decision is resolved.
    const stillOpen = await pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(stillOpen).toBeNull()
  })

  it('merchant NO cancels a pending order — F-3 regression', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { bot: { enabled: false } } })
    const conv = await createConversation(db, merchant.id)
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [],
      agreedTotal: 5000,
      prompt: 'Order detected — Reply YES.',
    })

    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'no'))

    const stillOpen = await pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(stillOpen).toBeNull()
    // No order created.
    const allOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(allOrders).toHaveLength(0)
    // Merchant got an "Order cancelled" notification.
    const messages = natsPublish.mock.calls.map(c => c[0] as { message?: string })
    expect(messages.some(m => /cancelled/i.test(m.message ?? ''))).toBe(true)
  })

  it('merchant numeric reply within 10x range creates order at that price — F-3 regression', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { bot: { enabled: false } } })
    const conv = await createConversation(db, merchant.id)
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'rice', quantity: 3 }],
      agreedTotal: 5000,
      prompt: '',
    })

    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, '4500'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(4500)
  })

  it('merchant numeric reply out of range prompts for CONFIRM — F-3 regression', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id)
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'rice', quantity: 3 }],
      agreedTotal: 5000,
      prompt: '',
    })

    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, '50')) // 0.01x — out of range

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)

    const messages = natsPublish.mock.calls.map(c => c[0] as { message?: string })
    expect(messages.some(m => /CONFIRM 50/i.test(m.message ?? ''))).toBe(true)

    // Pending decision is still OPEN.
    const stillOpen = await pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(stillOpen).not.toBeNull()
  })

  it('CONFIRM <amount> bypasses the range check — F-3 regression', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id)
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'rice', quantity: 3 }],
      agreedTotal: 5000,
      prompt: '',
    })

    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'CONFIRM 50'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(50)
  })

  it('"YES 5000" does NOT create two orders — F-3 regression (mutually exclusive branches)', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id)
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'rice', quantity: 3 }],
      agreedTotal: 5000,
      prompt: '',
    })

    // "YES 5000" should NOT match isYes (multi-word) and should NOT match
    // parsePriceReply (has prefix text). Net effect: pending stays open.
    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'YES 5000'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)

    const stillOpen = await pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(stillOpen).not.toBeNull()
  })

  it('unrecognized merchant reply during pending payment leaves state intact — F-3 regression', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await pending.upsert(merchant.id, 'PENDING_PAYMENT_REVIEW', {
      orderId: 'order-1',
      reason: 'low_confidence',
    })

    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'tomorrow at 3pm'))

    // Pending payment review still open.
    const stillOpen = await pending.get(merchant.id, 'PENDING_PAYMENT_REVIEW')
    expect(stillOpen).not.toBeNull()
  })
})

describe('MessageHandler — customer NLP path (F-10/F-11 integration)', () => {
  it('Bot Mode quotes a known product from catalog', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500', aliases: ['bag rice'] })

    analyseMock.mockResolvedValueOnce({
      intent: 'INQUIRY',
      items: [{ productName: 'bag rice', quantity: 1 }],
      agreementSignalDetected: false,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'how much for bag rice?'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.notification.send',
      to: CUSTOMER_PHONE,
      message: 'Yes, rice is ₦5,000.',
    }))
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, CUSTOMER_PHONE),
    })
    expect(conv?.state).toBe('NEGOTIATING')
    expect((conv?.context as { minimumAcceptableTotal?: number }).minimumAcceptableTotal).toBe(4500)
  })

  it('Bot Mode accepts a counter above floor and stores the quote', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'rice', quantity: 1, unitPrice: 5000, floorUnitPrice: 4500 }],
        negotiationHistory: [],
        lastQuotedPrice: 5000,
        minimumAcceptableTotal: 4500,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'COUNTER_OFFER',
      items: [],
      agreementSignalDetected: false,
      counterOfferPrice: 4700,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'do 4700'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      message: 'I can do ₦4,700 for it.',
    }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(4700)
  })

  it('Bot Mode counters below floor without going below last price', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'rice', quantity: 1, unitPrice: 5000, floorUnitPrice: 4500 }],
        negotiationHistory: [],
        lastQuotedPrice: 5000,
        minimumAcceptableTotal: 4500,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'COUNTER_OFFER',
      items: [],
      agreementSignalDetected: false,
      counterOfferPrice: 4000,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, '4k last'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      message: 'I can do ₦4,500 for it.',
    }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(4500)
  })

  it('Bot Mode replies to payment-intent price offers during negotiation', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'Louis Vuitton Monogram Shirt', quantity: 1, unitPrice: 135000, floorUnitPrice: 125000 }],
        negotiationHistory: [],
        lastQuotedPrice: 135000,
        minimumAcceptableTotal: 125000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'PAYMENT_INTENT',
      items: [],
      agreementSignalDetected: false,
      lastMentionedPrice: 100000,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, "That's on a high side na, let me pay 100k"))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      message: 'I can do ₦125,000 for it.',
    }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(125000)
  })

  it('Bot Mode replies to raw price offers even when NLP returns NONE', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'Louis Vuitton Monogram Shirt', quantity: 1, unitPrice: 135000, floorUnitPrice: 125000 }],
        negotiationHistory: [],
        lastQuotedPrice: 135000,
        minimumAcceptableTotal: 125000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.4,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, "That's on a high side, I will pay 100k"))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      message: 'I can do ₦125,000 for it.',
    }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(125000)
  })

  it('Bot Mode treats account detail requests as agreement, not another stale price offer', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'Louis Vuitton Monogram Shirt', quantity: 1, unitPrice: 135000, floorUnitPrice: 125000, agreedPrice: 125000 }],
        negotiationHistory: [],
        lastQuotedPrice: 125000,
        minimumAcceptableTotal: 125000,
        agreedPrice: 125000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'PAYMENT_INTENT',
      items: [],
      agreementSignalDetected: false,
      lastMentionedPrice: 125000,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Acc details'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Alright. Do you want to add anything else, or should I confirm this one?',
    }))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'I can do ₦125,000 for it.',
    }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { awaitingOrderConfirmation?: boolean }).awaitingOrderConfirmation).toBe(true)
  })

  it('Bot Mode asks whether to add more before creating the order', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const product = await createProduct(db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productId: product.id, productName: 'rice', quantity: 1, unitPrice: 5000, floorUnitPrice: 4500, agreedPrice: 4700 }],
        negotiationHistory: [],
        lastQuotedPrice: 4700,
        minimumAcceptableTotal: 4500,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'yes'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Alright. Do you want to add anything else, or should I confirm this one?',
    }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
    expect((conv?.context as { awaitingOrderConfirmation?: boolean }).awaitingOrderConfirmation).toBe(true)
  })

  it('Bot Mode creates an order after the customer confirms with no more items', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const product = await createProduct(db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'AGREED',
      context: {
        currentItems: [{ productId: product.id, productName: 'rice', quantity: 1, unitPrice: 5000, floorUnitPrice: 4500, agreedPrice: 4700 }],
        negotiationHistory: [],
        lastQuotedPrice: 4700,
        minimumAcceptableTotal: 4500,
        agreedPrice: 4700,
        awaitingOrderConfirmation: true,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'confirm it'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Order summary:'),
    }))
    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(4700)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
    const items = await db.query.orderItems.findMany({ where: eq(orderItems.orderId, createdOrders[0].id) })
    expect(items[0].productId).toBe(product.id)
  })

  it('Bot Mode escalates unknown products and does not create an order', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'rice', price: '5000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'beans', quantity: 1 }],
      agreementSignalDetected: false,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want beans'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      message: expect.stringContaining('unknown product "beans"'),
    }))
  })

  it('DONE while awaiting payment creates pending payment review and merchant template', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const order = await createOrder(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      status: 'AWAITING_PAYMENT',
      total: '150000',
      subtotal: '150000',
    })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'AWAITING_PAYMENT',
      context: {
        currentItems: [],
        negotiationHistory: [],
        orderId: order.id,
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'DONE'))

    const paymentRows = await db.query.payments.findMany({ where: eq(payments.orderId, order.id) })
    expect(paymentRows).toHaveLength(1)
    expect(paymentRows[0].status).toBe('PENDING')
    await expect(pending.get(merchant.id, 'PENDING_PAYMENT_REVIEW')).resolves.toEqual(expect.objectContaining({ orderId: order.id }))
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      template: expect.objectContaining({ name: 'mesa_payment_needs_confirmation_v2' }),
    }))
  })

  it('AI quota exhausted notifies merchant once + drops message — F-10 regression', async () => {
    const { handler, db, redis, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, subscriptionTier: 'starter' })
    await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    // Exhaust the quota.
    const key = `ai_quota:${merchant.id}:${lagosDateKey()}`
    await redis.set(key, '501')

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want 3 bags of rice'))

    // NLP must NOT have run.
    expect(analyseMock).not.toHaveBeenCalled()

    // Merchant got the quota-exhausted notification.
    const messages = natsPublish.mock.calls.map(c => c[0] as { message?: string })
    expect(messages.some(m => /Daily AI processing limit/i.test(m.message ?? ''))).toBe(true)
  })

  it('appends customer message to the recent-messages buffer — F-11 regression', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    analyseMock.mockResolvedValue({
      intent: 'INQUIRY',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'how much for rice?'))

    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const recent = (refreshed?.context as { recentMessages?: Array<{ text: string }> })?.recentMessages
    expect(recent).toBeDefined()
    expect(recent!).toContainEqual(expect.objectContaining({ text: 'how much for rice?' }))
  })

  it('passes raw message history to NLP (not price-only) — F-11 regression', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [],
        negotiationHistory: [],
        recentMessages: [
          { role: 'customer', text: 'how much for rice?', ts: '2026-01-01' },
          { role: 'vendor', text: '₦5000', ts: '2026-01-01' },
        ],
        lastMessageAt: '2026-01-01',
      },
    })

    analyseMock.mockResolvedValue({
      intent: 'COUNTER_OFFER',
      items: [],
      agreementSignalDetected: false,
      counterOfferPrice: 4500,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'abeg do 4500'))

    // analyseMessage receives raw text history, not price-only.
    const [, history] = analyseMock.mock.calls[0]
    expect(history).toEqual([
      { role: 'customer', text: 'how much for rice?' },
      { role: 'vendor', text: '₦5000' },
    ])
  })
})

describe('MessageHandler — WhatsApp coexistence', () => {
  it('treats WhatsApp document receipts as payment screenshots while awaiting payment', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createMerchantChannel(db, merchant.id, { channelAccountId: 'pn_x', accessToken: 'token_x' })
    const order = await createOrder(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      status: 'AWAITING_PAYMENT',
      total: '150000',
      subtotal: '150000',
    })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'AWAITING_PAYMENT',
      context: {
        currentItems: [],
        negotiationHistory: [],
        orderId: order.id,
        lastMessageAt: new Date().toISOString(),
      },
    })
    jest.mocked(downloadMedia).mockResolvedValueOnce({
      buffer: Buffer.from('pdf-receipt'),
      mimeType: 'application/pdf',
    })
    jest.mocked(uploadScreenshot).mockResolvedValueOnce('https://r2.test/receipt.pdf')

    await handler.handle(inboundMedia(merchant.id, CUSTOMER_PHONE, 'document'))

    expect(downloadMedia).toHaveBeenCalledWith('media_123', 'token_x')
    expect(uploadScreenshot).toHaveBeenCalledWith(Buffer.from('pdf-receipt'), 'application/pdf')
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.payment.screenshot_received',
      orderId: order.id,
      merchantId: merchant.id,
      screenshotUrl: 'https://r2.test/receipt.pdf',
    }))
  })

  it('merchant app echo to Mesa accepts a pending order from WhatsApp', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [{ productName: 'rice', quantity: 2 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'rice', quantity: 2 }],
      agreedTotal: 150000,
      prompt: 'Reply accept, reject, or send a new total.',
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, 'accept'))

    const createdOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(150000)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
  })

  it('merchant app echo to Mesa can confirm a pending order with a new total', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [{ productName: 'rice', quantity: 2 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'rice', quantity: 2 }],
      agreedTotal: 150000,
      prompt: 'Reply accept, reject, or send a new total.',
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, '140000'))

    const createdOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(140000)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
  })

  it('merchant app echo to Mesa can correct items and total before confirming', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [{ productName: 'rice', quantity: 2 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'rice', quantity: 2 }],
      agreedTotal: 150000,
      prompt: 'Reply accept, reject, or send a new total.',
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, '2x rice, 1x beans = 180000'))

    const createdOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
      with: { items: true },
    })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(180000)
    expect(createdOrders[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: 'rice', quantity: 2 }),
      expect.objectContaining({ productName: 'beans', quantity: 1 }),
    ]))
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
  })

  it('merchant app echo appends vendor context and pauses automation for the customer', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, 'I will handle this one'))

    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const context = refreshed?.context as {
      recentMessages?: Array<{ role: string; text: string }>
      manualLastAt?: string
      automationPausedUntil?: string
    }
    expect(context.recentMessages).toContainEqual(expect.objectContaining({
      role: 'vendor',
      text: 'I will handle this one',
    }))
    expect(context.manualLastAt).toBeDefined()
    expect(new Date(context.automationPausedUntil!).getTime()).toBeGreaterThan(Date.now())
  })

  it('non-commerce customer text during manual pause is stored but does not call NLP or publish automation', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [],
        negotiationHistory: [],
        automationPausedUntil: future,
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'thanks'))

    expect(analyseMock).not.toHaveBeenCalled()
    expect(natsPublish).not.toHaveBeenCalled()

    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const recent = (refreshed?.context as { recentMessages?: Array<{ role: string; text: string }> })?.recentMessages
    expect(recent).toContainEqual(expect.objectContaining({
      role: 'customer',
      text: 'thanks',
    }))
  })

  it('commerce customer text during manual pause still runs automation', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { bot: { enabled: false } } })
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [],
        negotiationHistory: [],
        automationPausedUntil: future,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 3, unitPrice: 5000 }],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want 3 bags of rice'))

    expect(analyseMock).toHaveBeenCalledTimes(1)
    const events = natsPublish.mock.calls.map(c => c[0] as { subject?: string; agreedTotal?: number })
    expect(events.some(e => e.subject === 'mesa.order.detected' && e.agreedTotal === 15000)).toBe(true)
  })

  it('captures order after customer inquiry, merchant price echo, then customer agreement', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { bot: { enabled: false } } })
    await createProduct(db, merchant.id, { name: 'rice', price: '5000' })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    analyseMock.mockResolvedValueOnce({
      intent: 'INQUIRY',
      items: [{ productName: 'rice', quantity: 1 }],
      agreementSignalDetected: false,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'how much for rice?'))
    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, '₦5000'))

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'ok'))

    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const context = refreshed?.context as {
      lastQuotedPrice?: number
      automationPausedUntil?: string
    }
    expect(context.lastQuotedPrice).toBe(5000)
    expect(context.automationPausedUntil).toBeUndefined()

    const events = natsPublish.mock.calls.map(c => c[0] as { subject?: string; agreedTotal?: number })
    expect(events.some(e => e.subject === 'mesa.order.detected' && e.agreedTotal === 5000)).toBe(true)
  })

  it('stale merchant echo does not revive an old agreed order context', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const staleAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'AGREED',
      context: {
        currentItems: [{ productName: 'rice', quantity: 2 }],
        negotiationHistory: [],
        agreedPrice: 150000,
        lastQuotedPrice: 150000,
        recentMessages: [
          { role: 'customer', text: 'I want 2 bags of rice', ts: staleAt },
          { role: 'customer', text: 'Okay, I will take it', ts: staleAt },
        ],
        lastMessageAt: staleAt,
      },
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, '130k last price'))

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Oya na'))

    const events = natsPublish.mock.calls.map(c => c[0] as { subject?: string; items?: unknown[] })
    expect(events.some(e => e.subject === 'mesa.order.detected')).toBe(false)

    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const context = refreshed?.context as {
      currentItems?: Array<{ productName: string; quantity: number }>
      agreedPrice?: number
      recentMessages?: Array<{ role: string; text: string }>
    }
    expect(context.currentItems).toEqual([])
    expect(context.agreedPrice).toBeUndefined()
    expect(context.recentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'vendor', text: '130k last price' }),
      expect.objectContaining({ role: 'customer', text: 'Oya na' }),
    ]))
  })

  it('starts a fresh order when an agreed conversation receives a new product request', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { bot: { enabled: false } } })
    await createProduct(db, merchant.id, { name: 'rice', price: '75000' })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'AGREED',
      context: {
        currentItems: [{ productName: 'blue shirt', quantity: 1 }],
        negotiationHistory: [],
        agreedPrice: 0,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 2 }],
      agreementSignalDetected: false,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Hello I want to buy 2 bag of rice'))

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Okay, I will take it'))

    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const context = refreshed?.context as {
      currentItems?: Array<{ productName: string; quantity: number }>
    }
    expect(context.currentItems).toEqual([{ productName: 'rice', quantity: 2 }])

    const events = natsPublish.mock.calls.map(c => c[0] as { subject?: string; agreedTotal?: number })
    expect(events.some(e => e.subject === 'mesa.order.detected' && e.agreedTotal === 150000)).toBe(true)
  })

  it('history sync appends context without running NLP or publishing automation', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })

    await handler.handleHistorySync({
      subject: 'mesa.whatsapp.history_sync',
      merchantId: merchant.id,
      channelAccountId: 'pn_x',
      messages: [
        {
          channel: 'whatsapp',
          channelAccountId: 'pn_x',
          customerId: CUSTOMER_PHONE,
          messageId: 'hist_1',
          timestamp: 1,
          type: 'text',
          text: 'how much?',
          direction: 'customer',
          historical: true,
        },
        {
          channel: 'whatsapp',
          channelAccountId: 'pn_x',
          customerId: CUSTOMER_PHONE,
          messageId: 'hist_2',
          timestamp: 2,
          type: 'text',
          text: '₦5000',
          direction: 'vendor',
          historical: true,
        },
      ],
    })

    expect(analyseMock).not.toHaveBeenCalled()
    expect(natsPublish).not.toHaveBeenCalled()

    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, CUSTOMER_PHONE),
    })
    const recent = (refreshed?.context as { recentMessages?: Array<{ role: string; text: string }> })?.recentMessages
    expect(recent).toEqual([
      expect.objectContaining({ role: 'customer', text: 'how much?' }),
      expect.objectContaining({ role: 'vendor', text: '₦5000' }),
    ])
  })

  it('contact sync is acknowledged without side effects', async () => {
    const { handler, natsPublish } = build()
    await expect(handler.handleContactSync({
      subject: 'mesa.whatsapp.contact_sync',
      merchantId: 'merchant-id',
      channelAccountId: 'pn_x',
      contacts: [{ customerId: CUSTOMER_PHONE, name: 'Customer' }],
    })).resolves.toBeUndefined()
    expect(natsPublish).not.toHaveBeenCalled()
  })
})

describe('MessageHandler — manual fulfilment', () => {
  it('payment confirmation starts fulfilment with the combined merchant template', async () => {
    const { db, fulfilmentHandler, natsPublish, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop' })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE, customerName: 'John' })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      customerName: 'John',
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()

    await fulfilmentHandler.startAfterPayment({
      subject: 'mesa.payment.confirmed',
      merchantId: merchant.id,
      orderId: order.id,
      amount: 150000,
    })

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.notification.send',
      to: MERCHANT_PHONE,
      template: expect.objectContaining({
        name: 'mesa_payment_confirmed',
        bodyParams: [
          order.id.slice(-8).toUpperCase(),
          `John(${CUSTOMER_PHONE})`,
          'Order items unavailable',
          '₦150,000',
        ],
        buttons: [
          { type: 'quick_reply', index: 0, payload: 'book_rider' },
          { type: 'quick_reply', index: 1, payload: 'self_deliver' },
          { type: 'quick_reply', index: 2, payload: 'pickup' },
        ],
      }),
    }))
    await expect(pending.get(merchant.id, 'PENDING_FULFILMENT_DECISION')).resolves.toEqual(
      expect.objectContaining({ orderId: order.id, customerName: 'John' }),
    )
  })

  it('merchant BOOK RIDER asks the customer for a delivery address', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    const [fulfilment] = await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'PENDING',
      packageDescription: '2x rice',
      packageValue: '150000',
    }).returning()
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: order.id,
      fulfilmentId: fulfilment.id,
      customerPhone: CUSTOMER_PHONE,
      itemsSummary: '2x rice',
      totalPaid: 150000,
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, 'BOOK RIDER'))

    const refreshed = await db.query.fulfilments.findFirst({
      where: eq(fulfilments.id, fulfilment.id),
    })
    expect(refreshed?.mode).toBe('BOOK_RIDER')
    expect(refreshed?.status).toBe('ADDRESS_REQUIRED')
    await expect(pending.get(merchant.id, 'PENDING_FULFILMENT_DECISION')).resolves.toBeNull()

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: CUSTOMER_PHONE,
      message: expect.stringMatching(/send your delivery address/i),
    }))
  })

  it('customer address creates a dispatch summary for the merchant', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop' })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'ADDRESS_REQUIRED',
      mode: 'BOOK_RIDER',
      packageDescription: '2x rice',
      packageValue: '150000',
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, '12 Admiralty Way, Lekki Phase 1'))

    const refreshed = await db.query.fulfilments.findFirst({
      where: eq(fulfilments.orderId, order.id),
    })
    expect(refreshed?.dropoffAddress).toBe('12 Admiralty Way, Lekki Phase 1')
    expect(refreshed?.status).toBe('READY_FOR_DISPATCH')
    expect(refreshed?.dispatchSummary).toMatch(/Dispatch details ready/i)
    expect(refreshed?.dispatchSummary).toMatch(/12 Admiralty Way/i)
    expect(analyseMock).not.toHaveBeenCalled()

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: MERCHANT_PHONE,
      message: expect.stringMatching(/Manual fulfilment MVP/i),
    }))
    expect(messages).toContainEqual(expect.objectContaining({
      to: CUSTOMER_PHONE,
      message: expect.stringMatching(/address has been received/i),
    }))
  })
})
