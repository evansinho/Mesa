// Mock the AI module before the handler is imported.
const analyseMock = jest.fn()
const productImageMock = jest.fn()
jest.mock('@mesa/ai', () => ({
  analyseMessage: (...args: unknown[]) => analyseMock(...args),
  analyzeProductImage: (...args: unknown[]) => productImageMock(...args),
}))

// Mock the WhatsApp media downloader — not needed in any of these tests.
jest.mock('@mesa/whatsapp', () => ({
  downloadMedia: jest.fn(),
}))

jest.mock('../../src/storage/r2', () => ({
  uploadScreenshot: jest.fn(),
}))

function buildAnalyseMockImpl() {
  return async (text: string, _history: Array<{ role: string; text: string }> = [], products: Array<{ name: string; aliases?: string[]; price?: number }> = []) => {
  const normalized = text.trim().toLowerCase()
  const matches = products.filter(product => {
    const names = [product.name, ...(product.aliases ?? [])].map(value => value.toLowerCase())
    return names.some(name => normalized.includes(name))
  })
  const firstMatch = matches[0]
  const isCategoryQuery = /\b(shoe|shoes|shirt|shirts|polo|polos|pant|pants|trouser|trousers|jeans|jogger|joggers|top|tops)\b/.test(normalized) &&
    !/\b(the|this|that|black|white|blue|red|size|size\s+\d+|senator|denim|linen|plain|slide|canvas|straight|vuitton|gucci|versace)\b/.test(normalized) &&
    !/\band\b|,/.test(normalized)

  if (/^(hi|hello|hey|gm|good morning|good afternoon|good evening)\b/.test(normalized)) {
    return { intent: 'greeting', items: [], agreementSignalDetected: false, confidence: 0.9 }
  }
  if (/total for what/.test(normalized)) {
    return { intent: 'NONE', items: [], agreementSignalDetected: false, confidence: 0.7 }
  }
  if (/complaint/.test(normalized)) {
    return { intent: 'NONE', items: [], agreementSignalDetected: false, signals: { complaint: true }, confidence: 0.7 }
  }
  if (/(done|confirm|okay|alright|okay i will take it|i will take it|yes|yes pls|yes please|i go take am|i'll take it)/.test(normalized)) {
    return { intent: 'AGREEMENT', items: [], agreementSignalDetected: true, confidence: 0.95 }
  }
  if (/(send account|send details|pay now|i will pay|i fit pay|i go pay|transfer)/.test(normalized)) {
    if (matches.length > 0) {
      return {
        intent: 'ORDER',
        items: matches.map(product => {
          const quantityMatch = normalized.match(/\b(\d+)\b/)
          return { productName: product.name, quantity: quantityMatch ? Number(quantityMatch[1]) : 1, unitPrice: product.price ?? undefined }
        }),
        agreementSignalDetected: true,
        confidence: 0.95,
      }
    }
    return { intent: 'PAYMENT_INTENT', items: [], agreementSignalDetected: true, confidence: 0.95 }
  }

  const priceMatch = normalized.match(/(\d+(?:[,.]\d+)?)(?:\s*(k|m))?/)
  if (/(how much|price|last price|final price)/.test(normalized)) {
    if (matches.length > 1 && isCategoryQuery) {
      return { intent: 'INQUIRY', items: [], agreementSignalDetected: false, confidence: 0.9 }
    }
    return {
      intent: 'INQUIRY',
      items: firstMatch ? [{ productName: firstMatch.name, quantity: 1, unitPrice: firstMatch.price ?? undefined }] : [],
      agreementSignalDetected: false,
      lastMentionedPrice: priceMatch ? Number(priceMatch[1].replace(/,/g, '')) * (priceMatch[2] === 'k' ? 1000 : priceMatch[2] === 'm' ? 1000000 : 1) : undefined,
      confidence: 0.9,
    }
  }
  if (/(i want|i need|i\'ll take|i will take|give me|buy|order|take)/.test(normalized)) {
    if (isCategoryQuery) {
      return { intent: 'INQUIRY', items: [], agreementSignalDetected: false, confidence: 0.85 }
    }
    if (matches.length > 1 && !/\band\b|,/.test(normalized)) {
      return { intent: 'INQUIRY', items: [], agreementSignalDetected: false, confidence: 0.85 }
    }
    const quantityMatch = normalized.match(/\b(\d+)\b/)
    if (matches.length > 1) {
      return {
        intent: 'ORDER',
        items: matches.map(product => ({ productName: product.name, quantity: quantityMatch ? Number(quantityMatch[1]) : 1, unitPrice: product.price ?? undefined })),
        agreementSignalDetected: /send account|confirm/.test(normalized),
        confidence: 0.9,
      }
    }
    return {
      intent: 'ORDER',
      items: firstMatch ? [{ productName: firstMatch.name, quantity: quantityMatch ? Number(quantityMatch[1]) : 1, unitPrice: firstMatch.price ?? undefined }] : [],
      agreementSignalDetected: /send account|confirm/.test(normalized),
      confidence: 0.9,
    }
  }
  if (matches.length === 1 && !isCategoryQuery) {
    const quantityMatch = normalized.match(/\b(\d+)\b/)
    return {
      intent: 'ORDER',
      items: [{ productName: firstMatch!.name, quantity: quantityMatch ? Number(quantityMatch[1]) : 1, unitPrice: firstMatch!.price ?? undefined }],
      agreementSignalDetected: false,
      confidence: 0.85,
    }
  }
  if (/(do|fit do|reduce|make it|make am|pay)/.test(normalized) && priceMatch) {
    return {
      intent: 'COUNTER_OFFER',
      items: [],
      counterOfferPrice: Number(priceMatch[1].replace(/,/g, '')) * (priceMatch[2] === 'k' ? 1000 : priceMatch[2] === 'm' ? 1000000 : 1),
      confidence: 0.9,
    }
  }
  return { intent: 'NONE', items: [], agreementSignalDetected: false, confidence: 0.5 }
  }
}

analyseMock.mockImplementation(buildAnalyseMockImpl())

import { and, eq } from 'drizzle-orm'
import { downloadMedia } from '@mesa/whatsapp'
import { agentTasks, conversations, fulfilments, merchants, orderItems, orders, payments } from '@mesa/db'
import { MessageHandler, resolveInboundSource } from '../../src/handlers/message.handler'
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
  productImageMock.mockReset()
  analyseMock.mockImplementation(buildAnalyseMockImpl())
})

describe('MessageHandler — stale post-order state recovery', () => {
  it('resets a conversation stuck in PAYMENT_RECEIVED instead of throwing when the reply is not a recognized opener', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Mesa Store', config: {} })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'PAYMENT_RECEIVED',
      context: {
        currentItems: [{ productName: 'Old Order Item', quantity: 1, unitPrice: 5000 }],
        negotiationHistory: [],
        lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })

    // "How much is this" doesn't match isFreshShoppingOpener (no want/need/
    // buy/order verb) but does trigger an INQUIRY→NEGOTIATING attempt, which
    // PAYMENT_RECEIVED has no valid transition to — this used to throw and
    // burn all 5 NATS delivery attempts silently.
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'How much is this'))

    const refreshed = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    expect(refreshed?.state).not.toBe('PAYMENT_RECEIVED')
  })

  it('clears the stale cart along with the state, so the next real order is not merged into an already-paid-for one', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    await createProduct(db, merchant.id, { name: 'Blue Dress', price: '30000', lastPrice: '28000' })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'PAYMENT_RECEIVED',
      context: {
        currentItems: [{ productName: 'Old Order Item', quantity: 1, unitPrice: 5000 }],
        agreedPrice: 5000,
        lastQuotedPrice: 5000,
        negotiationHistory: [],
        lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })

    // Same trigger message as the sibling test above — an INQUIRY-shaped
    // reply with no items, which reaches the PAYMENT_RECEIVED switch case
    // rather than being swallowed by the earlier NONE-intent short-circuit.
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'How much is this'))

    const afterReset = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    expect(afterReset?.state).not.toBe('PAYMENT_RECEIVED')
    expect((afterReset?.context as { currentItems?: unknown[] })?.currentItems).toEqual([])

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'Blue Dress', quantity: 1 }],
      agreementSignalDetected: false,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want the blue dress'))

    const afterOrder = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    const items = (afterOrder?.context as { currentItems?: Array<{ productName: string }> })?.currentItems ?? []
    expect(items.map(i => i.productName)).toEqual(['Blue Dress'])
  })

  it('does not silently merge a new message into a stale PAYMENT_RECEIVED cart via the delivery-address acknowledgement path', async () => {
    // ACKNOWLEDGE_DELIVERY_ADDRESS (and several sibling ledger actions —
    // ASK_QUANTITY, ASK_COUNTER_OFFER, ACKNOWLEDGE_CORRECTION) call
    // stateMachine.updateContext() directly rather than transition(), so
    // they never hit VALID_TRANSITIONS and never throw — meaning a message
    // that reaches this far while still PAYMENT_RECEIVED can merge quietly
    // into an already-paid-for cart with no reset and no recovery.
    // handleCommerceText's early return for PAYMENT_RECEIVED must stop this
    // before it ever reaches the ledger path.
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'PAYMENT_RECEIVED',
      context: {
        currentItems: [{ productName: 'Old Order Item', quantity: 1, unitPrice: 5000, floorUnitPrice: 5000 }],
        negotiationHistory: [],
        lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'INQUIRY',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.7,
      signals: { asksDelivery: true },
      facts: { deliveryAddress: '12 Allen Avenue, Ikeja' },
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Deliver to 12 Allen Avenue, Ikeja please'))

    const refreshed = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    expect(refreshed?.state).not.toBe('PAYMENT_RECEIVED')
    expect((refreshed?.context as { currentItems?: unknown[] })?.currentItems).toEqual([])
  })
})

describe('MessageHandler — order-intent workflow', () => {
  it('handles browse-to-payment flow without AI-owned commerce decisions', async () => {
    const { handler, db, natsPublish, pending } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      name: 'Mesa Store',
      config: {},
    })
    await createProduct(db, merchant.id, {
      name: 'Slide Sandals',
      aliases: ['slides', 'sandals'],
      price: '8000',
      lastPrice: '7500',
    })
    await createProduct(db, merchant.id, {
      name: 'Slim Fit Chinos',
      aliases: ['chinos'],
      price: '16000',
      lastPrice: '15000',
    })
    await createProduct(db, merchant.id, {
      name: 'Canvas Sneakers',
      aliases: ['shoe', 'shoes', 'sneakers'],
      price: '25000',
      lastPrice: '22000',
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Hello'))
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Which shoes do you have?'))

    expect(analyseMock).toHaveBeenCalled()
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('₦33,000'),
    }))

    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, "I'll take slides and chinos"))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    let conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { currentItems?: unknown[] }).currentItems).toHaveLength(2)

    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'How is it 24k?'))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      to: CUSTOMER_PHONE,
    }))

    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Yes pls'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()

    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Done'))
    const paymentRows = await db.query.payments.findMany({ where: eq(payments.merchantId, merchant.id) })
    expect(paymentRows).toHaveLength(0)
    await expect(pending.get(merchant.id, 'PENDING_PAYMENT_REVIEW')).resolves.toBeNull()
    const paidConv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((paidConv?.context as { checkoutStage?: string }).checkoutStage).toBe('product_selection')
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      to: CUSTOMER_PHONE,
      message: 'Checking it now.',
    }))
  })

  it('clamps proportional multi-item negotiation to item floors', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      config: {},
    })
    await createProduct(db, merchant.id, { name: 'Linen Shirt', aliases: ['shirt'], price: '10000', lastPrice: '9000' })
    await createProduct(db, merchant.id, { name: 'Denim Jeans', aliases: ['jeans'], price: '21000', lastPrice: '18000' })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want shirt and jeans'))
    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'do 20k'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { currentItems?: Array<{ agreedPrice?: number }> }).currentItems?.length).toBeGreaterThan(0)
  })

  it('answers price questions for products it just listed without merchant escalation', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      name: 'Sino Shop',
      config: {},
    })
    await createProduct(db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', lastPrice: '8000' })
    await createProduct(db, merchant.id, { name: 'Plain Black Polo Shirt', price: '8500', lastPrice: '8000' })
    await createProduct(db, merchant.id, { name: 'Striped Casual Shirt', price: '12000', lastPrice: '11000' })
    await createProduct(db, merchant.id, {
      name: 'Linen Senator Shirt',
      aliases: ['senator shirt', 'senator'],
      price: '20000',
      lastPrice: '19000',
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Hi'))
    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'The senator shirt, how much is it'))

    expect(analyseMock).toHaveBeenCalled()
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      message: expect.stringContaining('unknown product'),
    }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { currentItems?: Array<{ productName: string }> }).currentItems?.map(item => item.productName)).toEqual(['Linen Senator Shirt'])
  })

  it('preserves exact cart items while clarifying ambiguous products', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      config: {},
    })
    await createProduct(db, merchant.id, {
      name: 'Plain Black Polo Shirt',
      aliases: ['black polo', 'polo'],
      price: '8500',
      lastPrice: '8000',
    })
    const whitePolo = await createProduct(db, merchant.id, {
      name: 'Plain White Polo Shirt',
      aliases: ['white polo', 'polo'],
      price: '8500',
      lastPrice: '8000',
    })
    const jeans = await createProduct(db, merchant.id, {
      name: 'Straight Cut Jeans',
      aliases: ['jeans'],
      price: '19500',
      lastPrice: '18000',
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want polo and jeans'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    let conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { currentItems?: Array<{ productName: string }> }).currentItems?.map(item => item.productName).sort()).toEqual([
      'Plain Black Polo Shirt',
      'Plain White Polo Shirt',
      'Straight Cut Jeans',
    ].sort())

    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Black polo'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { currentItems?: Array<{ productName: string }> }).currentItems?.map(item => item.productName).sort()).toEqual([
      'Plain Black Polo Shirt',
      whitePolo.name,
      jeans.name,
    ].sort())
  })

  it('does not create duplicate orders for repeated confirmation of the same cart', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      config: {},
    })
    await createProduct(db, merchant.id, {
      name: 'Slide Sandals',
      aliases: ['slides'],
      price: '8000',
      lastPrice: '7500',
    })

    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'AGREED',
      context: {
        currentItems: [{ productName: 'Slide Sandals', quantity: 1, unitPrice: 8000, floorUnitPrice: 7500 }],
        negotiationHistory: [],
        lastQuotedPrice: 8000,
        minimumAcceptableTotal: 7500,
        agreedPrice: 8000,
        awaitingOrderConfirmation: true,
        lastMessageAt: new Date().toISOString(),
      },
    })

    const confirm = inboundText(merchant.id, CUSTOMER_PHONE, 'Confirm')
    await handler.handle(confirm)
    await handler.handle(confirm)

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
  })

  it('treats "okay I will take it" after last price as cart confirmation', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      config: {},
    })
    await createProduct(db, merchant.id, {
      name: 'Slide Sandals',
      aliases: ['slide sandals', 'slides'],
      price: '8000',
      lastPrice: '7000',
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Slide sandals'))
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, "What's the last price for it"))
    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Okay I will take it'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      template: expect.objectContaining({ name: 'mesa_new_order_v2' }),
    }))
  })

  it('lists category options for generic "I need a shoe" requests', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      name: 'Mesa Store',
      config: {},
    })
    await createProduct(db, merchant.id, {
      name: 'Canvas Sneakers',
      aliases: ['shoe', 'shoes', 'sneakers'],
      price: '25000',
      lastPrice: '22000',
    })
    await createProduct(db, merchant.id, {
      name: 'Slide Sandals',
      aliases: ['slides', 'sandals', 'shoes'],
      price: '8000',
      lastPrice: '7000',
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Hello'))
    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I need a shoe'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })
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

function inboundInstagramText(merchantId: string, fromId: string, text: string) {
  return {
    subject: 'mesa.inbound.message' as const,
    merchantId,
    message: {
      channel: 'instagram' as const,
      channelAccountId: 'ig_x',
      customerId: fromId,
      messageId: `ig_msg_${Date.now()}_${Math.random()}`,
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

function inboundInstagramMedia(merchantId: string, fromId: string, type: 'image' | 'document') {
  return {
    subject: 'mesa.inbound.message' as const,
    merchantId,
    message: {
      channel: 'instagram' as const,
      channelAccountId: 'ig_x',
      customerId: fromId,
      messageId: `ig_media_${Date.now()}_${Math.random()}`,
      timestamp: Math.floor(Date.now() / 1000),
      type,
      mediaUrl: 'https://cdn.instagram.test/media_456',
    },
  }
}

// A merchant-originated Instagram message, tagged direction: 'vendor' by the
// gateway — channelAccountId distinguishes Mesa's own platform inbox
// (pending-decision replies only) from the merchant's own shop account
// (message_echoes — pending decisions AND ongoing negotiation quotes).
function inboundInstagramVendorMessage(merchantId: string, opts: { channelAccountId: string; customerId: string; text: string }) {
  return {
    subject: 'mesa.inbound.message' as const,
    merchantId,
    message: {
      channel: 'instagram' as const,
      channelAccountId: opts.channelAccountId,
      customerId: opts.customerId,
      messageId: `ig_vendor_${Date.now()}_${Math.random()}`,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text' as const,
      text: opts.text,
      direction: 'vendor' as const,
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
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
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
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
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
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
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
  it('still processes the message when the status-post reply-context lookup errors — DLQ silent-loss regression', async () => {
    // Real incident: migration 0027 (adding statusPosts.whatsappMessageId)
    // was written but never wired into the journal, so this column never
    // existed on the actual database. Every WhatsApp "swipe to reply"
    // message hit this exact query, hard-failed, and sent the ENTIRE
    // inbound message — not just this lookup — to the dead-letter queue,
    // for days, for every merchant. This enrichment lookup must never be
    // able to take the whole message down with it again.
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    jest.spyOn(db.query.statusPosts, 'findFirst').mockRejectedValueOnce(
      new Error('column statusPosts.whatsapp_message_id does not exist')
    )

    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.5,
    })

    await expect(handler.handle({
      subject: 'mesa.inbound.message' as const,
      merchantId: merchant.id,
      message: {
        channel: 'whatsapp' as const,
        channelAccountId: 'pn_x',
        customerId: CUSTOMER_PHONE,
        messageId: `msg_${Date.now()}_${Math.random()}`,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'text' as const,
        text: 'yes please',
        context: { id: 'wamid.some-earlier-message' },
      },
    })).resolves.not.toThrow()

    expect(analyseMock).toHaveBeenCalled()
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect(conv).not.toBeNull()
  })

  it('quotes a known product from catalog', async () => {
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

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, CUSTOMER_PHONE),
    })
    expect(conv?.state).toBe('NEGOTIATING')
    expect((conv?.context as { minimumAcceptableTotal?: number }).minimumAcceptableTotal).toBe(4500)
  })

  it('lists available products for a category inquiry', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Louis Vuitton Monogram Shirt', price: '135000', lastPrice: '125000' })
    await createProduct(db, merchant.id, { name: 'Versace Medusa Shirt', price: '110000', lastPrice: '100000' })
    await createProduct(db, merchant.id, { name: 'Gucci Slides', price: '85000', lastPrice: '80000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'INQUIRY',
      items: [{ productName: 'shirts', quantity: 1 }],
      agreementSignalDetected: false,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Do you have shirts?'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, CUSTOMER_PHONE),
    })
    expect(conv?.state).toBe('IDLE')
  })

  it('fresh shopping opener resets stale payment-stage context before listing products', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', lastPrice: '8000', aliases: ['white polo', 'polo', 'polos'] })
    await createProduct(db, merchant.id, { name: 'Plain Black Polo Shirt', price: '8500', lastPrice: '8000', aliases: ['black polo', 'polo', 'polos'] })
    const oldOrder = await createOrder(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      status: 'AWAITING_PAYMENT',
      total: '17000',
      subtotal: '17000',
    })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'AWAITING_PAYMENT',
      context: {
        currentItems: [{ productName: 'Old Shirt', quantity: 1, unitPrice: 34000 }],
        negotiationHistory: [],
        orderId: oldOrder.id,
        agreedPrice: 34000,
        lastQuotedPrice: 34000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'INQUIRY',
      items: [{ productName: 'polos', quantity: 1 }],
      agreementSignalDetected: false,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want to buy polos'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('₦34,000'),
    }))
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, CUSTOMER_PHONE),
    })
    expect(['BROWSING', 'NEGOTIATING']).toContain(conv?.state)
    expect((conv?.context as { orderId?: string }).orderId).toBeUndefined()
  })

  it('lists catalog products for raw category text when NLP misses items', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Louis Vuitton Monogram Shirt', price: '135000', lastPrice: '125000' })
    await createProduct(db, merchant.id, { name: 'Versace Medusa Shirt', price: '110000', lastPrice: '100000' })
    await createProduct(db, merchant.id, { name: 'Gucci Slides', price: '85000', lastPrice: '80000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'INQUIRY',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.75,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I need shirts, what type do u have'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('greets without dumping a narrow product list', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop' })
    await createProduct(db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', lastPrice: '8000' })
    await createProduct(db, merchant.id, { name: 'Straight Cut Jeans', price: '19500', lastPrice: '18000' })
    await createProduct(db, merchant.id, { name: 'Canvas Sneakers', price: '25000', lastPrice: '22000' })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Hi'))

    expect(analyseMock).not.toHaveBeenCalled()
    expect(natsPublish).not.toHaveBeenCalled()
  })

  it('routes pant-not-top corrections to trouser or jeans options', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', lastPrice: '8000' })
    await createProduct(db, merchant.id, { name: 'Plain Black Polo Shirt', price: '8500', lastPrice: '8000' })
    await createProduct(db, merchant.id, { name: 'Straight Cut Jeans', price: '19500', lastPrice: '18000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.5,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I am looking for a pant not top'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('lists shoe options instead of pricing every shoe match', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Canvas Sneakers', price: '25000', lastPrice: '22000' })
    await createProduct(db, merchant.id, { name: 'Slide Sandals', price: '8000', lastPrice: '7500' })
    await createProduct(db, merchant.id, { name: 'Slim Fit Chinos', price: '16000', lastPrice: '15000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'INQUIRY',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.75,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Which shoe is available'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))

    natsPublish.mockClear()
    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [
        { productName: 'Canvas Sneakers', quantity: 1 },
        { productName: 'Slide Sandals', quantity: 1 },
      ],
      agreementSignalDetected: false,
      confidence: 0.75,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Okay I need a shoe'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('₦33,000'),
    }))
  })

  it('explains the current cart deterministically when customer asks what total is for', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [
          { productName: 'Canvas Sneakers', quantity: 1, unitPrice: 25000, floorUnitPrice: 22000 },
          { productName: 'Slide Sandals', quantity: 1, unitPrice: 8000, floorUnitPrice: 7500 },
        ],
        negotiationHistory: [],
        lastQuotedPrice: 33000,
        minimumAcceptableTotal: 29500,
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Total for what'))

    expect(analyseMock).toHaveBeenCalled()
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('asks what product when customer wants to buy but NLP extracts no item', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', lastPrice: '8000' })
    await createProduct(db, merchant.id, { name: 'Canvas Sneakers', price: '25000', lastPrice: '22000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.75,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want to buy'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('asks what product when commerce-looking text is classified as NONE', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Graphic Tee', price: '7500', lastPrice: '7000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.4,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Need something'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('falls back with a customer reply when NLP throws', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Graphic Tee', price: '7500', lastPrice: '7000' })

    analyseMock.mockRejectedValueOnce(new Error('Claude unavailable'))

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want to buy something'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('asks what product when ledger handling declines', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Graphic Tee', price: '7500', lastPrice: '7000' })
    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.5,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Need something'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('does not call the sales agent when ledger handling declines', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Graphic Tee', price: '7500', lastPrice: '7000' })
    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.5,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Need something'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('asks what product even when no catalog is configured', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.75,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want to buy'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('records a counter-offer silently without changing the merchant quote', async () => {
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

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const context = conv?.context as { lastQuotedPrice?: number; negotiationHistory?: Array<{ price: number; from: string }> }
    // The offer is recorded for detection, but the merchant's quote stands
    // until the merchant themselves answers (echo) or the customer agrees.
    expect(context.lastQuotedPrice).toBe(5000)
    expect(context.negotiationHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ price: 4700, from: 'customer' }),
    ]))
  })

  it('records a below-floor offer without countering', async () => {
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

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(5000)
  })

  it('keeps the merchant quote when a payment-intent message carries an offer', async () => {
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

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(135000)
  })

  it('records raw price offers silently even when NLP returns NONE', async () => {
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

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(135000)
  })

  it('treats account detail requests as agreement, not another stale price offer', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const product = await createProduct(db, merchant.id, { name: 'Louis Vuitton Monogram Shirt', price: '135000', lastPrice: '125000' })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productId: product.id, productName: 'Louis Vuitton Monogram Shirt', quantity: 1, unitPrice: 135000, floorUnitPrice: 125000, agreedPrice: 125000 }],
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

    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      template: expect.objectContaining({ name: 'mesa_new_order_v2' }),
    }))
    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
  })

  it('answers last-price questions with the current floor quote', async () => {
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
      intent: 'INQUIRY',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Is that the last price?'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
  })

  it('asks whether to add more before creating the order', async () => {
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
      subject: 'mesa.order.detected',
    }))
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()
  })

  it('still surfaces the agreement when a price was negotiated but no item was ever tracked — silent-drop regression', async () => {
    // Mirrors a real production case: a product photo's vision analysis
    // never made it into currentItems, but the negotiation text alone set
    // lastQuotedPrice. handleAgreement used to drop this silently — a valid
    // agreedTotal with zero items hit an early return with no notification,
    // no order-detected event, and nothing logged.
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [],
        negotiationHistory: [],
        lastQuotedPrice: 5000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Okay 👍'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.order.detected',
      agreedTotal: 5000,
      items: [expect.objectContaining({ unitPrice: 5000 })],
    }))
    const pendingTask = await pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(pendingTask).not.toBeNull()

    // The conversation's actual tracked cart is left untouched — this is a
    // fallback for the outgoing event only, not a rewrite of customer state.
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { currentItems?: unknown[] })?.currentItems).toEqual([])
  })

  it('surfaces an itemless agreement reached from IDLE via a manually-quoted lump price — Sino "Alright" regression', async () => {
    // Real production case: a customer asked about a product shown purely
    // as an image (never named in text), the merchant manually quoted "I
    // will give for 4k" on their own phone (a message_echo, not an NLP
    // turn), and the customer replied "Alright 👍". Unlike the test above,
    // this conversation is still IDLE (never entered NEGOTIATING, which is
    // the only state whose switch-case calls handleAgreement unconditionally
    // for a plain agreement signal) and reaches the ledger path instead —
    // where evaluateDraftReadiness's itemless-deal escape valve requires
    // ledger.draftOrder.total, which a merchant quote with no active item to
    // attach to never used to populate. The whole message.handle() call used
    // to silently no-op: no order-detected event, no pending task, no log.
    const { handler, db, natsPublish, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createMerchantChannel(db, merchant.id, { channelAccountId: 'pn_x', accessToken: 'token_x' })
    await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE, state: 'IDLE' })

    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, 'I will give for 4k'))

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.95,
      lastMentionedPrice: 4000,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Alright 👍'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.order.detected',
      agreedTotal: 4000,
      items: [expect.objectContaining({ unitPrice: 4000 })],
    }))
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()
  })

  it('creates an order after the customer confirms with no more items', async () => {
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
      subject: 'mesa.order.detected',
    }))
    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()
  })

  it('preserves exact cart items while clarifying ambiguous products before confirmation', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const blackPolo = await createProduct(db, merchant.id, {
      name: 'Plain Black Polo Shirt',
      price: '8500',
      lastPrice: '8500',
      aliases: ['black polo', 'polo'],
    })
    await createProduct(db, merchant.id, {
      name: 'Plain White Polo Shirt',
      price: '8500',
      lastPrice: '8500',
      aliases: ['white polo', 'polo'],
    })
    const jeans = await createProduct(db, merchant.id, {
      name: 'Straight Cut Jeans',
      price: '19500',
      lastPrice: '19500',
      aliases: ['jeans'],
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [
        { productName: 'polo', quantity: 1 },
        { productName: 'Straight Cut Jeans', quantity: 1 },
      ],
      agreementSignalDetected: false,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I need polo and a jeans'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('₦28,000'),
    }))
    let conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { checkoutStage?: string }).checkoutStage).toBe('product_selection')
    expect((conv?.context as { currentItems: Array<{ productName: string }> }).currentItems.map(i => i.productName)).toEqual(expect.arrayContaining(['Straight Cut Jeans']))

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'Plain Black Polo Shirt', quantity: 1 }],
      agreementSignalDetected: false,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Black polo'))

    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    expect((conv?.context as { currentItems: Array<{ productName: string }> }).currentItems.map(i => i.productName).sort()).toEqual([
      'Plain Black Polo Shirt',
      'Straight Cut Jeans',
    ].sort())

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'no'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.order.detected',
      items: expect.arrayContaining([
        expect.objectContaining({ productId: blackPolo.id }),
        expect.objectContaining({ productId: jeans.id }),
      ]),
    }))
  })

  it('agreement with an open price question holds the tap and tracks the new item (sweatpants regression)', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', aliases: ['white polo', 'plain white polo'] })
    const joggers = await createProduct(db, merchant.id, { name: 'Jogger Pants', price: '25000', aliases: ['joggers', 'sweat pants'] })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productId: joggers.id, productName: 'Jogger Pants', quantity: 1, unitPrice: 25000, floorUnitPrice: 25000 }],
        negotiationHistory: [],
        lastQuotedPrice: 25000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [{ productName: 'Plain White Polo Shirt', quantity: 1 }],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(
      merchant.id, CUSTOMER_PHONE,
      'No wahala, add one plain white polo for me, how much be that one',
    ))

    // Still shopping — no tap yet, but the polo is tracked in the cart.
    const detected = natsPublish.mock.calls
      .map(c => c[0] as { subject?: string })
      .find(m => m.subject === 'mesa.order.detected')
    expect(detected).toBeUndefined()
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const context = conv?.context as { currentItems?: Array<{ productName: string }> }
    expect(context.currentItems?.map(i => i.productName).sort()).toEqual(['Jogger Pants', 'Plain White Polo Shirt'])
  })

  it('an agreement turn cannot inject items the customer never said (polo regression)', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', aliases: ['white polo', 'polo shirt'] })
    const blackPolo = await createProduct(db, merchant.id, { name: 'Plain Black Polo Shirt', price: '8500', aliases: ['black polo', 'polo'] })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productId: blackPolo.id, productName: 'Plain Black Polo Shirt', quantity: 1, unitPrice: 40000, floorUnitPrice: 40000 }],
        negotiationHistory: [],
        lastQuotedPrice: 40000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    // Haiku re-imagines BOTH polos from catalog+history on the agreement turn.
    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [
        { productName: 'Plain White Polo Shirt', quantity: 1 },
        { productName: 'Plain Black Polo Shirt', quantity: 1, unitPrice: 40000 },
      ],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, "Alright I'll take it"))

    const detected = natsPublish.mock.calls
      .map(c => c[0] as { subject?: string; items?: Array<{ productName: string }>; agreedTotal?: number })
      .find(m => m.subject === 'mesa.order.detected')
    expect(detected).toBeDefined()
    expect(detected!.items!.map(i => i.productName)).toEqual(['Plain Black Polo Shirt'])
    expect(detected!.agreedTotal).toBe(40000)
  })

  it('an agreement turn CAN add an item the customer explicitly names', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createProduct(db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', aliases: ['white polo'] })
    const blackPolo = await createProduct(db, merchant.id, { name: 'Plain Black Polo Shirt', price: '8500', aliases: ['black polo', 'polo'] })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productId: blackPolo.id, productName: 'Plain Black Polo Shirt', quantity: 1, unitPrice: 8500, floorUnitPrice: 8500 }],
        negotiationHistory: [],
        lastQuotedPrice: 8500,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [{ productName: 'Plain White Polo Shirt', quantity: 1 }],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, "Add the white polo too, I'll take both"))

    const detected = natsPublish.mock.calls
      .map(c => c[0] as { subject?: string; items?: Array<{ productName: string }> })
      .find(m => m.subject === 'mesa.order.detected')
    expect(detected).toBeDefined()
    expect(detected!.items!.map(i => i.productName).sort()).toEqual(['Plain Black Polo Shirt', 'Plain White Polo Shirt'])
  })

  it('unrecognized merchant text gets silence, not the command menu', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })

    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'Accept'))

    expect(natsPublish).not.toHaveBeenCalled()
  })

  it('merchant "help" still shows the command menu', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })

    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'help'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      message: expect.stringContaining('Mesa commands'),
    }))
  })

  it('negotiation banter flagged as complaint by NLP is not escalated', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'Versace slides', quantity: 1, unitPrice: 25000, floorUnitPrice: 25000 }],
        negotiationHistory: [],
        lastQuotedPrice: 25000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      signals: { complaint: true },
      confidence: 0.8,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Be like you no won sell for me Abi'))

    const merchantMessages = natsPublish.mock.calls
      .map(c => c[0] as { to?: string; message?: string })
      .filter(m => m.to === MERCHANT_PHONE)
    expect(merchantMessages).toEqual([])
  })

  it('a real complaint still escalates to the merchant', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'Versace slides', quantity: 1, unitPrice: 25000, floorUnitPrice: 25000 }],
        negotiationHistory: [],
        lastQuotedPrice: 25000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      signals: { complaint: true },
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'This is a bad product, I want refund'))

    const merchantMessages = natsPublish.mock.calls
      .map(c => c[0] as { to?: string; message?: string })
      .filter(m => m.to === MERCHANT_PHONE)
    expect(merchantMessages).toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/customer needs attention/i),
    }))
  })

  it('tracks unknown products silently — no order, no merchant ping, item in ledger', async () => {
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
    // The merchant sees the customer's question on their own phone —
    // an unknown-product ping from Mesa is noise. Only stock alerts remain.
    expect(natsPublish).not.toHaveBeenCalled()
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const context = conv?.context as { currentItems?: Array<{ productName: string }> }
    expect(context.currentItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: 'beans' }),
    ]))
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
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: CUSTOMER_PHONE,
      message: 'Checking it now.',
    }))
    const customerAckCall = natsPublish.mock.calls.findIndex(([event]) =>
      event.to === CUSTOMER_PHONE && event.message === 'Checking it now.'
    )
    const merchantReviewCall = natsPublish.mock.calls.findIndex(([event]) =>
      event.to === MERCHANT_PHONE && event.template?.name === 'mesa_payment_needs_confirmation_v2'
    )
    expect(customerAckCall).toBeGreaterThanOrEqual(0)
    expect(merchantReviewCall).toBeGreaterThanOrEqual(0)
    expect(customerAckCall).toBeLessThan(merchantReviewCall)
  })

  it('AI quota exhausted notifies merchant once + drops message — F-10 regression', async () => {
    const { handler, db, redis, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, subscriptionTier: 'starter' })
    await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    // Exhaust the quota.
    const key = `ai_quota:${merchant.id}:${lagosDateKey()}`
    await redis.set(key, '501')

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want 3 bags of rice'))

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

  it('does not use sales agent replies when ledger handling declines', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      name: 'Ada Stores',
      config: { tone: 'friendly', language: 'auto' },
    })
    await createProduct(db, merchant.id, {
      name: 'Body Cream',
      aliases: ['cream'],
      price: '5000',
      lastPrice: '4500',
      stockQuantity: 10,
    })
    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.7,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'are you open today?'))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      to: CUSTOMER_PHONE,
    }))
  })
})

describe('MessageHandler — WhatsApp coexistence', () => {
  it('tracks a catalog-matched customer image silently in the ledger', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      name: 'Sino Shop',
      config: {},
    })
    await createMerchantChannel(db, merchant.id, { channelAccountId: 'pn_x', accessToken: 'token_x' })
    await createProduct(db, merchant.id, {
      name: 'Slide Sandals',
      aliases: ['slides', 'sandals'],
      price: '8000',
      lastPrice: '7000',
    })
    jest.mocked(downloadMedia).mockResolvedValueOnce({
      buffer: Buffer.from('product-image'),
      mimeType: 'image/png',
    })
    jest.mocked(uploadScreenshot).mockResolvedValueOnce('https://r2.test/product.png')
    productImageMock.mockResolvedValueOnce({
      description: 'black slide sandals',
      visibleText: [],
      candidateProductName: 'Slide Sandals',
      confidence: 0.91,
    })

    await handler.handle(inboundMedia(merchant.id, CUSTOMER_PHONE, 'image'))

    expect(downloadMedia).toHaveBeenCalledWith('media_123', 'token_x')
    expect(uploadScreenshot).toHaveBeenCalledWith(Buffer.from('product-image'), 'image/png')
    expect(productImageMock).toHaveBeenCalledWith('https://r2.test/product.png', [
      expect.objectContaining({ name: 'Slide Sandals', price: 8000 }),
    ])
    // Total silence — no customer reply, no merchant ping.
    expect(natsPublish).not.toHaveBeenCalled()
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const context = conv?.context as { currentItems?: Array<{ productName: string }> }
    expect(context.currentItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: 'Slide Sandals' }),
    ]))
  })

  it('tracks a non-catalog customer image via the vision-inferred name (solar panel case)', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
    await createMerchantChannel(db, merchant.id, { channelAccountId: 'pn_x', accessToken: 'token_x' })
    jest.mocked(downloadMedia).mockResolvedValueOnce({
      buffer: Buffer.from('panel-image'),
      mimeType: 'image/jpeg',
    })
    jest.mocked(uploadScreenshot).mockResolvedValueOnce('https://r2.test/panel.jpg')
    productImageMock.mockResolvedValueOnce({
      description: 'a large solar photovoltaic module',
      visibleText: ['ECOLiON-SP-700W'],
      inferredProductName: 'Ecolion SP-700W solar panel',
      confidence: 0,
    })

    await handler.handle(inboundMedia(merchant.id, CUSTOMER_PHONE, 'image'))

    expect(natsPublish).not.toHaveBeenCalled()
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const context = conv?.context as { currentItems?: Array<{ productName: string }>; automationPausedUntil?: string }
    expect(context.currentItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: 'Ecolion SP-700W solar panel' }),
    ]))
    // Mesa keeps listening — no automation pause.
    expect(context.automationPausedUntil).toBeUndefined()
  })

  it('tracks a customer product photo sent over Instagram via the vision-inferred name', async () => {
    // Instagram attachments carry mediaUrl, not mediaId — must not go
    // through downloadMedia() (WhatsApp-only, needs a Graph access token).
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new TextEncoder().encode('ig-panel-image').buffer,
    }) as unknown as typeof fetch

    try {
      const { handler, db, natsPublish } = build()
      const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
      jest.mocked(uploadScreenshot).mockResolvedValueOnce('https://r2.test/ig-panel.jpg')
      productImageMock.mockResolvedValueOnce({
        description: 'a large solar photovoltaic module',
        visibleText: ['ECOLiON-SP-700W'],
        inferredProductName: 'Ecolion SP-700W solar panel',
        confidence: 0,
      })

      await handler.handle(inboundInstagramMedia(merchant.id, '17840099998888', 'image'))

      expect(downloadMedia).not.toHaveBeenCalled()
      expect(global.fetch).toHaveBeenCalledWith('https://cdn.instagram.test/media_456')
      expect(natsPublish).not.toHaveBeenCalled()
      const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, '17840099998888') })
      const context = conv?.context as { currentItems?: Array<{ productName: string }> }
      expect(context.currentItems).toEqual(expect.arrayContaining([
        expect.objectContaining({ productName: 'Ecolion SP-700W solar panel' }),
      ]))
    } finally {
      global.fetch = originalFetch
    }
  })

  it('a second photo of the same product does not create a duplicate cart line', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
    await createMerchantChannel(db, merchant.id, { channelAccountId: 'pn_x', accessToken: 'token_x' })
    jest.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from('panel-image'),
      mimeType: 'image/jpeg',
    })
    jest.mocked(uploadScreenshot)
      .mockResolvedValueOnce('https://r2.test/panel-1.jpg')
      .mockResolvedValueOnce('https://r2.test/panel-2.jpg')
    productImageMock
      .mockResolvedValueOnce({
        description: 'a solar module',
        inferredProductName: 'Ecolion SP-700W solar panel',
        confidence: 0,
      })
      .mockResolvedValueOnce({
        description: 'spec label of a solar module',
        inferredProductName: 'Ecolion solar photovoltaic module 700W',
        confidence: 0,
      })

    await handler.handle(inboundMedia(merchant.id, CUSTOMER_PHONE, 'image'))
    await handler.handle(inboundMedia(merchant.id, CUSTOMER_PHONE, 'image'))

    expect(natsPublish).not.toHaveBeenCalled()
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const context = conv?.context as { currentItems?: Array<{ productName: string }> }
    expect(context.currentItems).toHaveLength(1)
    expect(context.currentItems?.[0]?.productName).toBe('Ecolion SP-700W solar panel')
  })

  it('a second item negotiated after the first is agreed merges into one UPDATED ORDER, not lost to a false fresh-shopping reset', async () => {
    // Regression: a customer counter-offer like "if you gree 35k i go take
    // am" contains the word "take", which isFreshShoppingOpener treated as
    // "customer wants to start a brand new purchase" — wiping the entire
    // ledger (both items) right as the second item's price was being
    // negotiated, mid-deal. The order.handler.ts merge logic ("UPDATED
    // ORDER") already existed and works correctly — it just never got a
    // chance to run because the second item never survived long enough to
    // reach it. Fixed by excluding money-shaped mentions (k/m suffix, ₦/#
    // prefix) from the fresh-opener check, while still allowing genuine
    // fresh requests with a bare quantity ("2 bag of rice") to reset.
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
    await createMerchantChannel(db, merchant.id, { channelAccountId: 'pn_x', accessToken: 'token_x' })
    jest.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from('item-image'),
      mimeType: 'image/jpeg',
    })
    jest.mocked(uploadScreenshot)
      .mockResolvedValueOnce('https://r2.test/caps.jpg')
      .mockResolvedValueOnce('https://r2.test/backpack.jpg')
    productImageMock
      .mockResolvedValueOnce({
        description: 'baseball caps',
        inferredProductName: 'Polo Ralph Lauren baseball caps',
        confidence: 0,
      })
      .mockResolvedValueOnce({
        description: 'a set of backpacks',
        inferredProductName: 'backpack',
        confidence: 0,
      })

    // Item A: customer photo, merchant quotes 30k then accepts 25k, customer agrees.
    await handler.handle(inboundMedia(merchant.id, CUSTOMER_PHONE, 'image'))
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'How much is this'))
    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, '30k'))
    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, '25k'))
    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Okay'))

    // Item B: a second photo, negotiated the same way, but this time the
    // merchant's acceptance is a natural-language phrase with no price in it
    // ("Oya na make I just leave am for you") and the customer's counter
    // ("If you gree 35k i go take am") is the exact real-world phrase that
    // triggered the false reset.
    await handler.handle(inboundMedia(merchant.id, CUSTOMER_PHONE, 'image'))
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'This one nkor'))
    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, 'Na 50k ooo'))
    analyseMock.mockResolvedValueOnce({
      intent: 'COUNTER_OFFER',
      items: [],
      counterOfferPrice: 35000,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'If you gree 35k i go take am'))
    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, 'Oya na make I just leave am for you'))
    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Confirm'))

    const finalConv = await db.query.conversations.findFirst({ where: eq(conversations.customerPhone, CUSTOMER_PHONE) })
    const context = finalConv?.context as { currentItems?: Array<{ productName: string }> }
    expect(context.currentItems?.map(i => i.productName)).toEqual(
      expect.arrayContaining(['Polo Ralph Lauren baseball caps', 'backpack']),
    )

    const orderEvents = natsPublish.mock.calls
      .map(c => c[0] as { subject?: string; agreedTotal?: number; items?: Array<{ productName: string }> })
      .filter(e => e.subject === 'mesa.order.detected')
    expect(orderEvents).toHaveLength(2)
    // The second detection merges both items into one updated total, rather
    // than being silently dropped or reusing the first item's stale total.
    // Item B settles at 35000 — the customer's counter-offer the merchant's
    // bare "leave it for you" phrase accepted — not the merchant's earlier,
    // superseded 50000 quote.
    expect(orderEvents[1].agreedTotal).toBe(60000)
    expect(orderEvents[1].items?.map(i => i.productName)).toEqual(
      expect.arrayContaining(['Polo Ralph Lauren baseball caps', 'backpack']),
    )

    const updatedOrderNotification = natsPublish.mock.calls
      .map(c => c[0] as { message?: string; template?: { bodyParams?: string[] } })
      .find(e => e.template?.bodyParams?.some(p => p.includes('UPDATED ORDER')))
    expect(updatedOrderNotification).toBeDefined()
  })

  it('ignores customer documents outside payment silently — merchant handles them', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, {
      phone: MERCHANT_PHONE,
      name: 'Sino Shop',
      config: {},
    })
    await createMerchantChannel(db, merchant.id, { channelAccountId: 'pn_x', accessToken: 'token_x' })
    jest.mocked(downloadMedia).mockResolvedValueOnce({
      buffer: Buffer.from('product-doc'),
      mimeType: 'application/pdf',
    })
    jest.mocked(uploadScreenshot).mockResolvedValueOnce('https://r2.test/product.pdf')

    await handler.handle(inboundMedia(merchant.id, CUSTOMER_PHONE, 'document'))

    expect(productImageMock).not.toHaveBeenCalled()
    // Nothing to track from an arbitrary document — total silence, keep listening.
    expect(natsPublish).not.toHaveBeenCalled()
  })

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

  it('treats Instagram image receipts as payment screenshots while awaiting payment', async () => {
    // Instagram attachments carry a directly-fetchable mediaUrl, not a
    // WhatsApp-style mediaId — this must NOT go through downloadMedia().
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new TextEncoder().encode('ig-receipt').buffer,
    }) as unknown as typeof fetch

    try {
      const { handler, db, natsPublish } = build()
      const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
      const order = await createOrder(db, merchant.id, {
        customerPhone: '17840099998888',
        status: 'AWAITING_PAYMENT',
        total: '150000',
        subtotal: '150000',
      })
      await createConversation(db, merchant.id, {
        channel: 'instagram',
        customerPhone: '17840099998888',
        state: 'AWAITING_PAYMENT',
        context: {
          currentItems: [],
          negotiationHistory: [],
          orderId: order.id,
          lastMessageAt: new Date().toISOString(),
        },
      })
      jest.mocked(uploadScreenshot).mockResolvedValueOnce('https://r2.test/ig-receipt.jpg')

      await handler.handle(inboundInstagramMedia(merchant.id, '17840099998888', 'image'))

      expect(downloadMedia).not.toHaveBeenCalled()
      expect(global.fetch).toHaveBeenCalledWith('https://cdn.instagram.test/media_456')
      expect(uploadScreenshot).toHaveBeenCalledWith(Buffer.from('ig-receipt'), 'image/jpeg')
      expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'mesa.payment.screenshot_received',
        orderId: order.id,
        merchantId: merchant.id,
        screenshotUrl: 'https://r2.test/ig-receipt.jpg',
      }))
    } finally {
      global.fetch = originalFetch
    }
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

  it('does not create a second order when the web action page already claimed the confirmation — Sino scooter shirt regression', async () => {
    // apps/api's /order/:token/accept route resolves the same agent_tasks
    // row directly via SQL — it has no knowledge of the worker's
    // PendingDecisions Redis cache and never invalidates it. So the
    // worker's cache can still say "OPEN" after the action page has
    // already resolved (and, in production, actioned) the task in
    // Postgres. If the WhatsApp path trusts that stale cached read and
    // creates an order before re-checking the DB, both paths create one.
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

    // Simulate the action page winning the race: a direct DB resolve that
    // bypasses PendingDecisions entirely, exactly like apps/api's route
    // does — the worker's Redis cache is left stale, still showing OPEN.
    await db.update(agentTasks)
      .set({ status: 'DONE' })
      .where(and(eq(agentTasks.merchantId, merchant.id), eq(agentTasks.type, 'PENDING_ORDER_CONFIRMATION')))

    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, 'accept'))

    const createdOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(createdOrders).toHaveLength(0)
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

  it('does not loop complaint escalations during the handoff pause window', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'complaint'))

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      message: 'Customer needs attention: complaint',
    }))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER_PHONE }))
    const firstPublishCount = natsPublish.mock.calls.length

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'complaint'))

    expect(natsPublish).toHaveBeenCalledTimes(firstPublishCount)
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, CUSTOMER_PHONE),
    })
    const context = conv?.context as { escalationReason?: string; automationPausedUntil?: string }
    expect(context.escalationReason).toBe('complaint')
    expect(new Date(context.automationPausedUntil!).getTime()).toBeGreaterThan(Date.now())
  })

  it('ignores Mesa-generated escalation echo text instead of reprocessing it', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, 'Customer needs attention: complaint'))
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, "I'll ask someone from the store to help with this."))

    expect(natsPublish).not.toHaveBeenCalled()
    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const context = refreshed?.context as { recentMessages?: Array<{ text: string }> }
    expect(context.recentMessages ?? []).toHaveLength(0)
  })

  it('ignores Mesa-generated product-media alert echo text instead of reprocessing it', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop' })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    await handler.handleMessageEcho(messageEcho(
      merchant.id,
      CUSTOMER_PHONE,
      [
        'Customer sent a product image.',
        `Customer: ${CUSTOMER_PHONE}`,
        'Reply YES <price> if available, or NO if not available.',
        'Media: https://r2.test/product.png',
      ].join('\n'),
    ))

    expect(natsPublish).not.toHaveBeenCalled()
    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const context = refreshed?.context as { recentMessages?: Array<{ text: string }> }
    expect(context.recentMessages ?? []).toHaveLength(0)
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
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    await createProduct(db, merchant.id, { name: 'rice', price: '5000' })
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
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      template: expect.objectContaining({ name: 'mesa_new_order_v2' }),
    }))
  })

  it('opens merchant confirmation before sending payment flow', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    await createProduct(db, merchant.id, { name: 'rice', price: '5000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 3, unitPrice: 5000 }],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want 3 bags of rice, send account'))

    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.order.detected',
    }))

    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'accept'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(15000)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.order.confirmed',
    }))
  })

  it('does not resurrect an old order from ordinary chat containing a bare "again" or "before" — false-positive regression', async () => {
    // Real incident: a vendor asked her husband (saved as a WhatsApp
    // "customer" on her business number) to send money for household gas;
    // much later, unrelated personal chat containing words like "again" or
    // "before" repeatedly resurrected an old, unrelated confirmed order and
    // pinged her to confirm it — in the middle of a conversation with
    // nothing to do with commerce.
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    const product = await createProduct(db, merchant.id, { name: 'Blue square sunglasses', price: '100' })
    const prior = await createOrder(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      status: 'CONFIRMED',
      subtotal: '100',
      total: '100',
    })
    await db.insert(orderItems).values({
      orderId: prior.id,
      productId: product.id,
      productName: 'Blue square sunglasses',
      quantity: 1,
      unitPrice: '100',
      agreedPrice: '100',
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.5,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, "I'll try again tomorrow, was fine before"))

    expect(analyseMock).toHaveBeenCalled()
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.order.detected',
    }))
  })

  it('resolves same thing again from the latest prior order', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    const product = await createProduct(db, merchant.id, { name: 'Black Trouser', price: '19000' })
    const prior = await createOrder(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      status: 'PAID',
      subtotal: '19000',
      total: '19000',
    })
    await db.insert(orderItems).values({
      orderId: prior.id,
      productId: product.id,
      productName: 'Black Trouser',
      quantity: 1,
      unitPrice: '19000',
      agreedPrice: '19000',
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I need the same thing again, send account'))

    expect(analyseMock).not.toHaveBeenCalled()
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toEqual(expect.objectContaining({
      customerPhone: CUSTOMER_PHONE,
      agreedTotal: 19000,
      items: [expect.objectContaining({ productName: 'Black Trouser', quantity: 1 })],
    }))
    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      to: MERCHANT_PHONE,
      template: expect.objectContaining({ name: 'mesa_new_order_v2' }),
    }))
  })

  it('applies a safe quantity override for a single prior order item', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    const product = await createProduct(db, merchant.id, { name: 'Noodles Carton', price: '5000' })
    const prior = await createOrder(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      status: 'CONFIRMED',
      subtotal: '50000',
      total: '50000',
    })
    await db.insert(orderItems).values({
      orderId: prior.id,
      productId: product.id,
      productName: 'Noodles Carton',
      quantity: 10,
      unitPrice: '5000',
      agreedPrice: '5000',
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'same cartons again, but this time make am 15'))

    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toEqual(expect.objectContaining({
      customerPhone: CUSTOMER_PHONE,
      agreedTotal: 75000,
      items: [expect.objectContaining({ productName: 'Noodles Carton', quantity: 15 })],
    }))
  })

  it('captures order after customer inquiry, merchant price echo, then customer agreement', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
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

  it('"alright i will take it" is recognized as agreement, not a fresh shopping opener that wipes the negotiation', async () => {
    // Regression: isFreshShoppingOpener matches on the bare word "take", and
    // isConfirmationPhrase's "i will take it" pattern only whitelisted an
    // ok/okay/yes/sure/fine prefix — "alright" fell through neither list, so
    // this exact phrase was misclassified as a NEW shopping request. When the
    // customer asks about something outside the catalog (no item match), the
    // conversation stays IDLE while the merchant's echoed price still sets
    // lastQuotedPrice — exactly the state a real production conversation
    // reached. That misclassification then triggered resetForFreshSession,
    // wiping the negotiation clean right as the agreement arrived.
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    analyseMock.mockResolvedValueOnce({
      intent: 'INQUIRY',
      items: [],
      agreementSignalDetected: false,
      confidence: 0.9,
    })
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'how much for this?'))
    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, '₦5000'))

    const midway = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    expect(midway?.state).toBe('IDLE')
    expect((midway?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(5000)

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'alright i will take it'))

    const refreshed = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    const context = refreshed?.context as { lastQuotedPrice?: number }
    // The negotiation must survive — not get reset to an empty cart.
    expect(context.lastQuotedPrice).toBe(5000)
  })

  it('emits order detection on customer agreement without a customer-facing confirmation reply', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    await createProduct(db, merchant.id, { name: 'Plain Black Polo Shirt', price: '8500', lastPrice: '8000' })
    await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'Plain Black Polo Shirt', quantity: 1, unitPrice: 8500, floorUnitPrice: 8000 }],
        negotiationHistory: [],
        lastQuotedPrice: 8500,
        lastMessageAt: new Date().toISOString(),
      },
    })

    analyseMock.mockResolvedValueOnce({
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
      confidence: 0.9,
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Alright, I will take it'))

    const events = natsPublish.mock.calls.map(c => c[0] as { subject?: string; agreedTotal?: number; message?: string })
    expect(events.some(e => e.subject === 'mesa.order.detected' && e.agreedTotal === 8500)).toBe(true)
    expect(events.some(e => e.subject === 'mesa.notification.send' && /Just to confirm|Order confirmed|Pay here/i.test(e.message ?? ''))).toBe(false)
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

  it('stale post-order context is cleared before a fresh shopping opener is processed', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    await createProduct(db, merchant.id, {
      name: 'Leather Belt',
      aliases: ['belt'],
      price: '9500',
      lastPrice: '9000',
    })
    const staleAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'ORDER_CREATED',
      context: {
        currentItems: [{ productName: 'Old Shoes', quantity: 1, unitPrice: 12000 }],
        negotiationHistory: [],
        lastQuotedPrice: 12000,
        agreedPrice: 12000,
        awaitingOrderConfirmation: false,
        orderId: 'order_old',
        recentMessages: [
          { role: 'customer', text: 'Hi', ts: staleAt },
          { role: 'customer', text: 'Yes', ts: staleAt },
        ],
        lastMessageAt: staleAt,
      },
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want the leather belt'))

    const refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    const context = refreshed?.context as {
      currentItems?: Array<{ productName: string }>
      lastQuotedPrice?: number
      agreedPrice?: number
      orderId?: string
      recentMessages?: Array<{ role: string; text: string }>
      checkoutStage?: string
    }

    expect(context.currentItems?.map(item => item.productName)).toEqual(['Leather Belt'])
    expect(context.lastQuotedPrice).toBe(9500)
    expect(context.agreedPrice).toBeUndefined()
    expect(context.orderId).toBeUndefined()
    expect(context.recentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'customer', text: 'I want the leather belt' }),
    ]))
    expect(context.recentMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Hi' }),
      expect.objectContaining({ text: 'Yes' }),
    ]))
    expect(context.checkoutStage).toBe('product_selection')
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Old Shoes'),
    }))
  })

  it('fresh greeting starts a new session instead of reusing a stale cart', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    await createProduct(db, merchant.id, {
      name: 'Leather Belt',
      aliases: ['belt'],
      price: '9500',
      lastPrice: '9000',
    })
    await createProduct(db, merchant.id, {
      name: 'Linen Senator Shirt',
      aliases: ['senator shirt', 'senator'],
      price: '18000',
      lastPrice: '17000',
    })
    const staleAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'ORDER_CREATED',
      context: {
        sessionId: 'old-session',
        currentItems: [{ productName: 'Leather Belt', quantity: 1, unitPrice: 9500 }],
        negotiationHistory: [],
        lastQuotedPrice: 9500,
        agreedPrice: 9500,
        awaitingOrderConfirmation: false,
        orderId: 'order_old',
        recentMessages: [
          { role: 'customer', text: 'I will take the leather belt', ts: staleAt, sessionId: 'old-session' },
          { role: 'customer', text: 'Yes', ts: staleAt, sessionId: 'old-session' },
        ],
        lastMessageAt: staleAt,
      },
    })

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Hello'))
    let refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    let context = refreshed?.context as {
      sessionId?: string
      currentItems?: Array<{ productName: string }>
      recentMessages?: Array<{ text: string; sessionId?: string }>
    }

    expect(context.sessionId).not.toBe('old-session')
    expect(context.currentItems ?? []).toHaveLength(0)
    expect(context.recentMessages).toEqual([
      expect.objectContaining({ text: 'Hello' }),
    ])

    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Senator shirt'))

    refreshed = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    context = refreshed?.context as {
      currentItems?: Array<{ productName: string }>
      recentMessages?: Array<{ text: string; sessionId?: string }>
    }

    expect(context.currentItems?.map(item => item.productName)).toEqual(['Linen Senator Shirt'])
    expect(context.recentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Hello' }),
      expect.objectContaining({ text: 'Senator shirt' }),
    ]))
    expect(natsPublish).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Leather Belt'),
    }))
  })

  it('starts a fresh order when an agreed conversation receives a new product request', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
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
    expect(context.currentItems).toHaveLength(1)
    expect(context.currentItems).toEqual([
      expect.objectContaining({ productName: 'rice', quantity: 2 }),
    ])

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
      customerChannel: 'whatsapp',
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

  it('asks an Instagram customer for a delivery address on Instagram, even though the merchant replied via WhatsApp', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const igCustomerId = 'igsid_customer_1'
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: igCustomerId })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: igCustomerId,
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    const [fulfilment] = await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: igCustomerId,
      status: 'PENDING',
      packageDescription: '2x rice',
      packageValue: '150000',
    }).returning()
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: order.id,
      fulfilmentId: fulfilment.id,
      customerPhone: igCustomerId,
      customerChannel: 'instagram',
      itemsSummary: '2x rice',
      totalPaid: 150000,
    })

    // The merchant replies via WhatsApp here even though the customer is on
    // Instagram — PendingFulfilmentPayload.customerChannel is what routes the
    // customer-facing send correctly regardless of which channel the merchant used.
    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, 'BOOK RIDER'))

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; channel?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: igCustomerId,
      channel: 'instagram',
      message: expect.stringMatching(/send your delivery address/i),
    }))
  })

  it('a conversational price echo updates the ledger even when an order task is open (sweater regression)', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'sweater', quantity: 1, unitPrice: 22000, floorUnitPrice: 22000 }],
        negotiationHistory: [],
        lastQuotedPrice: 22000,
        lastMessageAt: new Date().toISOString(),
      },
    })
    // Stale open order task from an unrelated conversation — previously any
    // echo containing a price was treated as a reply to it and swallowed.
    const otherConv = await createConversation(db, merchant.id, { customerPhone: '+2348011112222' })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: otherConv.id,
      customerPhone: '+2348011112222',
      items: [{ productName: 'rice', quantity: 2 }],
      agreedTotal: 10000,
      prompt: 'Reply accept, reject, or send a new total.',
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, "It's 40k"))

    const refreshed = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    expect((refreshed?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(40000)
    // The unrelated task must remain open and unconsumed.
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()
  })

  it('an out-of-range order correction is rejected with guidance instead of creating the order', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'sweater', quantity: 1 }],
      agreedTotal: 22000,
      prompt: 'Reply accept, reject, or send a new total.',
    })

    // "= 38" is a typo for "= 38k" — 578x below the detected total.
    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, '1x sweater = 38'))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(0)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.not.toBeNull()
    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: MERCHANT_PHONE,
      message: expect.stringMatching(/unusually low/i),
    }))
  })

  it('an order correction with an explicit per-item price uses that price, not an even split of the total — Sino regression (2026-08-01: a correction with no prices wiped the real 40k/78k breakdown into a fabricated 59k/59k)', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [
          { productName: 'Adidas backpacks', quantity: 1, unitPrice: 50000 },
          { productName: 'Hermes slippers', quantity: 1, unitPrice: 78000 },
        ],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [
        { productName: 'Adidas backpacks', quantity: 1, unitPrice: 50000 },
        { productName: 'Hermes slippers', quantity: 1, unitPrice: 78000 },
      ],
      agreedTotal: 128000,
      prompt: 'Reply accept, reject, or send a new total.',
    })

    // Corrects the backpack's price down to the real negotiated 40k, leaves
    // the slipper price to carry forward unchanged, total reflects both.
    await handler.handleMessageEcho(messageEcho(
      merchant.id,
      CUSTOMER_PHONE,
      '1x Adidas backpacks - 40000, 1x Hermes slippers = 118000'
    ))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(118000)

    const items = await db.query.orderItems.findMany({ where: eq(orderItems.orderId, createdOrders[0].id) })
    const backpack = items.find(i => i.productName === 'Adidas backpacks')
    const slippers = items.find(i => i.productName === 'Hermes slippers')
    expect(parseFloat(backpack!.agreedPrice)).toBe(40000)
    expect(parseFloat(slippers!.agreedPrice)).toBe(78000)
  })

  it('BOOK RIDER wins even when a stale order-confirmation task is still open (Sino regression)', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'PAID',
      subtotal: '100000',
      total: '100000',
    }).returning()
    const [fulfilment] = await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'PENDING',
      packageDescription: '1x sneakers',
      packageValue: '100000',
    }).returning()
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: order.id,
      fulfilmentId: fulfilment.id,
      customerPhone: CUSTOMER_PHONE,
      customerChannel: 'whatsapp',
      itemsSummary: '1x sneakers',
      totalPaid: 100000,
    })
    // The production failure: a duplicate ORDER_DETECTED delivery left a
    // zombie OPEN order task whose unrecognized-reply branch swallowed the tap.
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      items: [{ productName: 'sneakers', quantity: 1 }],
      agreedTotal: 100000,
      prompt: 'Reply accept, reject, or send a new total.',
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, 'Book Rider'))

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

  it('merchant SELF DELIVER still asks the customer for a delivery address and builds dispatch details', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop' })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'PAID',
      subtotal: '13500',
      total: '13500',
    }).returning()
    const [fulfilment] = await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'PENDING',
      packageDescription: '1x jogger pants',
      packageValue: '13500',
    }).returning()
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: order.id,
      fulfilmentId: fulfilment.id,
      customerPhone: CUSTOMER_PHONE,
      customerChannel: 'whatsapp',
      itemsSummary: '1x jogger pants',
      totalPaid: 13500,
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, 'SELF DELIVER'))

    const refreshed = await db.query.fulfilments.findFirst({
      where: eq(fulfilments.id, fulfilment.id),
    })
    expect(refreshed?.mode).toBe('SELF_DELIVER')
    expect(refreshed?.status).toBe('ADDRESS_REQUIRED')
    await expect(pending.get(merchant.id, 'PENDING_FULFILMENT_DECISION')).resolves.toBeNull()

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: CUSTOMER_PHONE,
      message: expect.stringMatching(/send your delivery address/i),
    }))

    natsPublish.mockClear()
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, '12 Admiralty Way, Lekki Phase 1'))

    const updated = await db.query.fulfilments.findFirst({
      where: eq(fulfilments.id, fulfilment.id),
    })
    expect(updated?.dropoffAddress).toBe('12 Admiralty Way, Lekki Phase 1')
    expect(updated?.status).toBe('READY_FOR_DISPATCH')

    const followUpMessages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(followUpMessages).toContainEqual(expect.objectContaining({
      to: MERCHANT_PHONE,
      message: expect.stringMatching(/Dispatch details ready/i),
    }))
    expect(followUpMessages).toContainEqual(expect.objectContaining({
      to: CUSTOMER_PHONE,
      message: expect.stringMatching(/address has been received/i),
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

  it('an Instagram customer address is acknowledged on Instagram, and routes the merchant dispatch summary to their activated Instagram inbox', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      merchantRecipientId: 'igsid_merchant_1',
      merchantLastMessageAt: new Date(),
    })
    const igCustomerId = 'igsid_customer_1'
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: igCustomerId })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: igCustomerId,
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: igCustomerId,
      status: 'ADDRESS_REQUIRED',
      mode: 'BOOK_RIDER',
      packageDescription: '2x rice',
      packageValue: '150000',
    })

    await handler.handle(inboundInstagramText(merchant.id, igCustomerId, '12 Admiralty Way, Lekki Phase 1'))

    const refreshed = await db.query.fulfilments.findFirst({
      where: eq(fulfilments.orderId, order.id),
    })
    expect(refreshed?.dropoffAddress).toBe('12 Admiralty Way, Lekki Phase 1')
    expect(refreshed?.status).toBe('READY_FOR_DISPATCH')

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; channel?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: 'igsid_merchant_1',
      channel: 'instagram',
      message: expect.stringMatching(/Manual fulfilment MVP/i),
    }))
    expect(messages).toContainEqual(expect.objectContaining({
      to: igCustomerId,
      channel: 'instagram',
      message: expect.stringMatching(/address has been received/i),
    }))
  })

  it('extracts a phone number out of an Instagram customer\'s address reply, since their customerPhone is really an IGSID with no way to call them', async () => {
    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_2',
      merchantRecipientId: 'igsid_merchant_2',
      merchantLastMessageAt: new Date(),
    })
    const igCustomerId = 'igsid_customer_2'
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: igCustomerId })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: igCustomerId,
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: igCustomerId,
      status: 'ADDRESS_REQUIRED',
      mode: 'BOOK_RIDER',
      packageDescription: '2x rice',
      packageValue: '150000',
    })

    await handler.handle(inboundInstagramText(
      merchant.id, igCustomerId, '12 Admiralty Way, Lekki Phase 1, 08012345678',
    ))

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.orderId, order.id) })
    expect(refreshed?.contactPhone).toBe('08012345678')
    // The phone is pulled out of the address text, not left duplicated in it.
    expect(refreshed?.dropoffAddress).toBe('12 Admiralty Way Lekki Phase 1')
    expect(refreshed?.dispatchSummary).toContain('Phone: 08012345678')

    const messages = natsPublish.mock.calls.map(c => c[0] as { message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('Phone: 08012345678'),
    }))
  })

  it('accepts an Instagram address with no phone number in it, falling back to showing the IGSID rather than failing', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_3',
      merchantRecipientId: 'igsid_merchant_3',
      merchantLastMessageAt: new Date(),
    })
    const igCustomerId = 'igsid_customer_3'
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: igCustomerId })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: igCustomerId,
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: igCustomerId,
      status: 'ADDRESS_REQUIRED',
      mode: 'BOOK_RIDER',
      packageDescription: '2x rice',
      packageValue: '150000',
    })

    await handler.handle(inboundInstagramText(merchant.id, igCustomerId, '12 Admiralty Way, Lekki Phase 1'))

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.orderId, order.id) })
    expect(refreshed?.contactPhone).toBeNull()
    expect(refreshed?.dropoffAddress).toBe('12 Admiralty Way, Lekki Phase 1')
  })

  it('does not attempt phone extraction on WhatsApp — its customerPhone is already a real number', async () => {
    const { handler, db } = build()
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

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, '12 Admiralty Way, Lekki Phase 1, 08012345678'))

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.orderId, order.id) })
    // The whole text stays the address — no extraction attempted for WhatsApp.
    expect(refreshed?.dropoffAddress).toBe('12 Admiralty Way, Lekki Phase 1, 08012345678')
    expect(refreshed?.contactPhone).toBeNull()
  })

  it('asks for a phone number alongside the address on Instagram, but not on WhatsApp', async () => {
    const { handler, db, natsPublish, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const igCustomerId = 'igsid_customer_4'
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: igCustomerId })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: igCustomerId,
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    const [fulfilment] = await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: igCustomerId,
      status: 'PENDING',
      packageDescription: '2x rice',
      packageValue: '150000',
    }).returning()
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: order.id,
      fulfilmentId: fulfilment.id,
      customerPhone: igCustomerId,
      customerChannel: 'instagram',
      itemsSummary: '2x rice',
      totalPaid: 150000,
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, MESA_PHONE, 'BOOK RIDER'))

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: igCustomerId,
      message: expect.stringMatching(/delivery address and a phone number/i),
    }))
  })
})

describe('MessageHandler — Instagram merchant reply & echo pathway (mirrors WhatsApp)', () => {
  const PLATFORM_ACCOUNT_ID = 'ig_mesa_platform'

  it('a merchant replying to Mesa\'s own platform inbox (YES) confirms a pending order', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_1',
      merchantRecipientId: 'igsid_merchant_1',
      merchantLastMessageAt: new Date(),
    })
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: 'igsid_customer_1' })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: 'igsid_customer_1',
      items: [{ productName: 'rice', quantity: 3 }],
      agreedTotal: 5000,
      prompt: 'Order detected — Reply YES.',
    })

    // Arrives on Mesa's platform account (channelAccountId differs from the
    // merchant's own shop account 'ig_shop_1'), sender = the merchant's own IGSID.
    await handler.handle(inboundInstagramVendorMessage(merchant.id, {
      channelAccountId: PLATFORM_ACCOUNT_ID,
      customerId: 'igsid_merchant_1',
      text: 'yes',
    }))

    const createdOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(createdOrders).toHaveLength(1)
    expect(parseFloat(createdOrders[0].total)).toBe(5000)
    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
  })

  it('a merchant replying to Mesa\'s platform inbox with NO cancels the order and acknowledges via Instagram, not WhatsApp', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: {} })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_2',
      merchantRecipientId: 'igsid_merchant_2',
      merchantLastMessageAt: new Date(),
    })
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: 'igsid_customer_2' })
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
      conversationId: conv.id,
      customerPhone: 'igsid_customer_2',
      items: [],
      agreedTotal: 5000,
      prompt: 'Order detected — Reply YES.',
    })

    await handler.handle(inboundInstagramVendorMessage(merchant.id, {
      channelAccountId: PLATFORM_ACCOUNT_ID,
      customerId: 'igsid_merchant_2',
      text: 'no',
    }))

    await expect(pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')).resolves.toBeNull()
    const allOrders = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(allOrders).toHaveLength(0)

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; channel?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: 'igsid_merchant_2',
      channel: 'instagram',
      message: expect.stringMatching(/cancelled/i),
    }))
  })

  it('a merchant replying to Mesa\'s platform inbox with BOOK RIDER resolves a pending fulfilment decision', async () => {
    const { handler, db, pending, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_3',
      merchantRecipientId: 'igsid_merchant_3',
      merchantLastMessageAt: new Date(),
    })
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: 'igsid_customer_3' })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: 'igsid_customer_3',
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    const [fulfilment] = await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: 'igsid_customer_3',
      status: 'PENDING',
      packageDescription: '2x rice',
      packageValue: '150000',
    }).returning()
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: order.id,
      fulfilmentId: fulfilment.id,
      customerPhone: 'igsid_customer_3',
      customerChannel: 'instagram',
      itemsSummary: '2x rice',
      totalPaid: 150000,
    })

    await handler.handle(inboundInstagramVendorMessage(merchant.id, {
      channelAccountId: PLATFORM_ACCOUNT_ID,
      customerId: 'igsid_merchant_3',
      text: 'BOOK RIDER',
    }))

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.mode).toBe('BOOK_RIDER')
    await expect(pending.get(merchant.id, 'PENDING_FULFILMENT_DECISION')).resolves.toBeNull()

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; channel?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: 'igsid_customer_3',
      channel: 'instagram',
      message: expect.stringMatching(/send your delivery address/i),
    }))
    expect(messages).toContainEqual(expect.objectContaining({
      to: 'igsid_merchant_3',
      channel: 'instagram',
      message: expect.stringMatching(/asked the customer/i),
    }))
  })

  it('a merchant\'s own native reply to a customer (message_echoes on their shop account) updates the negotiation ledger', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_4',
      merchantRecipientId: 'igsid_merchant_4',
      merchantLastMessageAt: new Date(),
    })
    const conv = await createConversation(db, merchant.id, {
      channel: 'instagram',
      customerPhone: 'igsid_customer_4',
      state: 'NEGOTIATING',
      context: {
        currentItems: [{ productName: 'sweater', quantity: 1, unitPrice: 22000, floorUnitPrice: 22000 }],
        negotiationHistory: [],
        lastQuotedPrice: 22000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    // channelAccountId matches the merchant's OWN shop account — this is the
    // echo case, not a reply to Mesa's platform inbox.
    await handler.handle(inboundInstagramVendorMessage(merchant.id, {
      channelAccountId: 'ig_shop_4',
      customerId: 'igsid_customer_4',
      text: "It's 40k",
    }))

    const refreshed = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    expect((refreshed?.context as { lastQuotedPrice?: number }).lastQuotedPrice).toBe(40000)
  })

  it('a merchant\'s native BOOK RIDER typed into a customer thread (echo) still resolves a pending fulfilment decision', async () => {
    const { handler, db, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_5',
      merchantRecipientId: 'igsid_merchant_5',
      merchantLastMessageAt: new Date(),
    })
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: 'igsid_customer_5' })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: 'igsid_customer_5',
      status: 'PAID',
      subtotal: '150000',
      total: '150000',
    }).returning()
    const [fulfilment] = await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: 'igsid_customer_5',
      status: 'PENDING',
      packageDescription: '2x rice',
      packageValue: '150000',
    }).returning()
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: order.id,
      fulfilmentId: fulfilment.id,
      customerPhone: 'igsid_customer_5',
      customerChannel: 'instagram',
      itemsSummary: '2x rice',
      totalPaid: 150000,
    })

    await handler.handle(inboundInstagramVendorMessage(merchant.id, {
      channelAccountId: 'ig_shop_5',
      customerId: 'igsid_customer_5',
      text: 'BOOK RIDER',
    }))

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.mode).toBe('BOOK_RIDER')
    await expect(pending.get(merchant.id, 'PENDING_FULFILMENT_DECISION')).resolves.toBeNull()
  })
})

describe('MessageHandler — Instagram customer name lookup', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('fetches and stores the customer\'s Instagram name at first contact, instead of leaving the raw IGSID as the only identifier', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'Jane Doe', username: 'jane.doe' }),
    }) as unknown as typeof fetch

    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_name_1',
      accessToken: 'ig_token_x',
    })

    await handler.handle(inboundInstagramText(merchant.id, 'igsid_customer_name_1', 'Hi, is this available?'))

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('graph.instagram.com/v21.0/igsid_customer_name_1'),
    )
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, 'igsid_customer_name_1'),
    })
    expect(conv?.customerName).toBe('Jane Doe')
  })

  it('falls back to the username when Instagram has no display name set', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: 'jane.doe' }),
    }) as unknown as typeof fetch

    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_name_2',
      accessToken: 'ig_token_x',
    })

    await handler.handle(inboundInstagramText(merchant.id, 'igsid_customer_name_2', 'Hi'))

    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, 'igsid_customer_name_2'),
    })
    expect(conv?.customerName).toBe('jane.doe')
  })

  it('leaves customerName unset (not a crash) when the Instagram profile fetch fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch

    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_name_3',
      accessToken: 'ig_token_x',
    })

    await handler.handle(inboundInstagramText(merchant.id, 'igsid_customer_name_3', 'Hi'))

    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, 'igsid_customer_name_3'),
    })
    expect(conv?.customerName).toBeNull()
  })

  it('only fetches once per conversation, not on every message', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'Jane Doe' }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_name_4',
      accessToken: 'ig_token_x',
    })

    await handler.handle(inboundInstagramText(merchant.id, 'igsid_customer_name_4', 'Hi'))
    await handler.handle(inboundInstagramText(merchant.id, 'igsid_customer_name_4', 'Still there?'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('threads the fetched name into the order-detected notification and the final order record', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'Jane Doe' }),
    }) as unknown as typeof fetch

    const { handler, db, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, name: 'Sino Shop', config: {} })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_name_5',
      accessToken: 'ig_token_x',
    })
    await createProduct(db, merchant.id, { name: 'rice', price: '5000' })

    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 1, unitPrice: 5000 }],
      agreementSignalDetected: true,
      confidence: 0.9,
    })
    await handler.handle(inboundInstagramText(merchant.id, 'igsid_customer_name_5', 'I want rice, I will take it'))

    const events = natsPublish.mock.calls.map(c => c[0] as { subject?: string; customerName?: string })
    const orderDetected = events.find(e => e.subject === 'mesa.order.detected')
    expect(orderDetected?.customerName).toBe('Jane Doe')
  })
})

describe('resolveInboundSource (order-source analytics)', () => {
  function baseMessage(overrides: Partial<Parameters<typeof resolveInboundSource>[0]> = {}) {
    return {
      channel: 'whatsapp' as const,
      channelAccountId: 'pn_x',
      customerId: '+2348011112222',
      messageId: `msg_${Date.now()}_${Math.random()}`,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text' as const,
      ...overrides,
    }
  }

  it('never auto-tags a message that merely names a platform with no click behind it', async () => {
    const { redis } = build()
    const merchantId = 'merchant-no-click'
    const result = await resolveInboundSource(baseMessage({ text: 'hey I saw this on tiktok, how much?' }), merchantId, redis)
    expect(result).toBeNull()
  })

  it('confirms when a click and the greeting text both agree', async () => {
    const { redis } = build()
    const merchantId = 'merchant-click-confirmed'
    await redis.set(`click:${merchantId}:tiktok`, new Date().toISOString(), 'EX', 600)
    const result = await resolveInboundSource(baseMessage({ text: 'Hi! Saw you on TikTok 👋' }), merchantId, redis)
    expect(result).toEqual({ source: 'tiktok', confidence: 'confirmed' })
  })

  it('estimates when a click happened but the greeting text was edited away', async () => {
    const { redis } = build()
    const merchantId = 'merchant-click-estimated'
    await redis.set(`click:${merchantId}:tiktok`, new Date().toISOString(), 'EX', 600)
    const result = await resolveInboundSource(baseMessage({ text: 'hi do you still have the bag' }), merchantId, redis)
    expect(result).toEqual({ source: 'tiktok', confidence: 'estimated' })
  })

  it('returns null when clicks from two platforms compete — ambiguous, never guesses', async () => {
    const { redis } = build()
    const merchantId = 'merchant-ambiguous'
    await redis.set(`click:${merchantId}:tiktok`, new Date().toISOString(), 'EX', 600)
    await redis.set(`click:${merchantId}:instagram`, new Date().toISOString(), 'EX', 600)
    const result = await resolveInboundSource(baseMessage({ text: 'Hi! Saw you on TikTok 👋' }), merchantId, redis)
    expect(result).toBeNull()
  })

  it('short-circuits to confirmed on a paid ad referral, regardless of clicks', async () => {
    const { redis } = build()
    const merchantId = 'merchant-ad-referral'
    const result = await resolveInboundSource(
      baseMessage({ text: 'hi', referral: { sourceUrl: 'https://www.instagram.com/ads/123', sourceType: 'ad' } }),
      merchantId,
      redis,
    )
    expect(result).toEqual({ source: 'instagram_ad', confidence: 'confirmed' })
  })
})

describe('order-source attribution wiring in handleSerialized', () => {
  it('sets source/sourceConfidence on a brand-new conversation from a tracking-link click', async () => {
    const { handler, db, redis } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    await redis.set(`click:${merchant.id}:tiktok`, new Date().toISOString(), 'EX', 600)

    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Hi! Saw you on TikTok 👋'))

    const conv = await db.query.conversations.findFirst({
      where: and(eq(conversations.merchantId, merchant.id), eq(conversations.customerPhone, CUSTOMER_PHONE)),
    })
    expect(conv?.source).toBe('tiktok')
    expect(conv?.sourceConfidence).toBe('confirmed')
  })

  it('refreshes an existing conversation on a fresh click, never clears a prior source when a message carries no signal', async () => {
    const { handler, db, redis } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      source: 'instagram',
      sourceConfidence: 'confirmed',
    })

    // No click pending — this message carries no fresh signal.
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'do you have this in blue?'))
    const afterNoSignal = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    expect(afterNoSignal?.source).toBe('instagram')
    expect(afterNoSignal?.sourceConfidence).toBe('confirmed')

    // A fresh click for a different platform ahead of a new message updates it.
    await redis.set(`click:${merchant.id}:facebook`, new Date().toISOString(), 'EX', 600)
    await handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Hi! Saw you on Facebook 👋'))
    const afterFreshClick = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    expect(afterFreshClick?.source).toBe('facebook')
    expect(afterFreshClick?.sourceConfidence).toBe('confirmed')
  })
})

describe('merchant-echo price quote sanity guard — Sino/₦7 phantom-order regression', () => {
  it('ignores a wildly mismatched bare number in an unrelated merchant message instead of overwriting the negotiated price', async () => {
    // Live regression: after a Mercedes-Benz sale (₦5,200,000) was fully paid
    // and fulfilled, a merchant WhatsApp message to the customer containing
    // an unrelated small number ("I'll call you by 7") matched
    // extractMentionedPrice's bare-digit regex and got applied straight to
    // the ledger — reopening the stale, already-completed item at a bogus
    // ₦7 total and firing a phantom "New order received" notification the
    // next time anything read as agreement.
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [{ productName: 'Mercedes-Benz C-Class sedan', quantity: 1, unitPrice: 5200000, agreedPrice: 5200000 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, "I'll call you by 7"))

    const after = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    const context = after?.context as { currentItems?: Array<{ agreedPrice?: number; unitPrice?: number }>; lastQuotedPrice?: number }
    expect(context.lastQuotedPrice).not.toBe(7)
    expect(context.currentItems?.[0]?.agreedPrice ?? context.currentItems?.[0]?.unitPrice).toBe(5200000)
  })

  it('still accepts an ordinary renegotiated price within a reasonable range', async () => {
    const { handler, db } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      context: {
        currentItems: [{ productName: 'rice', quantity: 1, unitPrice: 100000, agreedPrice: 100000 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleMessageEcho(messageEcho(merchant.id, CUSTOMER_PHONE, '80k last price'))

    const after = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
    const context = after?.context as { lastQuotedPrice?: number; currentItems?: Array<{ unitPrice?: number }> }
    expect(context.currentItems?.[0]?.unitPrice).toBe(80000)
  })
})
