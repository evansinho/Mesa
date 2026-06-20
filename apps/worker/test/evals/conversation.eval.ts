// Mesa Conversation Evaluation Suite
// Run with: MESA_RUN_INTEGRATION=1 pnpm --filter @mesa/worker test test/evals/

const analyseMock = jest.fn()
const salesReplyMock = jest.fn()
jest.mock('@mesa/ai', () => ({
  analyseMessage: (...a: unknown[]) => analyseMock(...a),
  generateSalesReply: (...a: unknown[]) => salesReplyMock(...a),
}))
jest.mock('@mesa/whatsapp', () => ({ downloadMedia: jest.fn() }))
jest.mock('../../src/storage/r2', () => ({ uploadScreenshot: jest.fn() }))

import { eq } from 'drizzle-orm'
import { conversations, orders } from '@mesa/db'
import { OrderDetectedEvent } from '@mesa/types'
import { MessageHandler } from '../../src/handlers/message.handler'
import { OrderHandler } from '../../src/handlers/order.handler'
import { PendingDecisions } from '../../src/handlers/pending-decisions'
import { AiQuota } from '../../src/ai/quota'
import { FulfilmentHandler } from '../../src/handlers/fulfilment.handler'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import {
  createMerchant,
  createConversation,
  createProduct,
  createOrder,
} from '@test-helpers/factories'

setupIntegration()

beforeEach(() => {
  analyseMock.mockReset()
  salesReplyMock.mockReset()
})
afterEach(() => jest.restoreAllMocks())

// ─── Shared infra ─────────────────────────────────────────────────────────────

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
  return { handler, orderHandler, natsPublish, db, redis, pending }
}

const MERCHANT_PHONE = '+2348012345678'
const CUSTOMER_PHONE = '+2348099998888'

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

function echoMsg(merchantId: string, toPhone: string, text: string) {
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

// ─── Scenario runner ──────────────────────────────────────────────────────────

type NlpResponse = {
  intent: 'ORDER' | 'INQUIRY' | 'COUNTER_OFFER' | 'AGREEMENT' | 'PAYMENT_INTENT' | 'MERCHANT_SETUP' | 'NONE'
  items?: { productName: string; quantity: number; unitPrice?: number }[]
  agreementSignalDetected?: boolean
  counterOfferPrice?: number
  lastMentionedPrice?: number
  confidence?: number
}

type TurnExpect = {
  botReplied?: string | RegExp
  merchantNotified?: string | RegExp
  state?: string
  orderCount?: number
  orderTotal?: number
  noReply?: boolean
  nlpNotCalled?: boolean
}

type Turn = {
  from: 'customer' | 'merchant' | 'echo'
  text: string
  nlp?: NlpResponse
  expect?: TurnExpect
}

type Rig = ReturnType<typeof build>

function repliesTo(natsPublish: jest.Mock, since: number, phone: string): string[] {
  return natsPublish.mock.calls
    .slice(since)
    .flatMap(c => {
      const e = c[0] as { to?: string; message?: string }
      return e.to === phone && e.message ? [e.message] : []
    })
}

function publishedSince(natsPublish: jest.Mock, since: number): Record<string, unknown>[] {
  return natsPublish.mock.calls.slice(since).map(c => c[0] as Record<string, unknown>)
}

async function runTurns(rig: Rig, merchantId: string, turns: Turn[]) {
  const { handler, natsPublish, db } = rig

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    const callsBefore = natsPublish.mock.calls.length
    const nlpCallsBefore = analyseMock.mock.calls.length
    const label = `Turn ${i + 1} ("${turn.text}")`

    if (turn.nlp) {
      analyseMock.mockResolvedValueOnce({
        items: [],
        agreementSignalDetected: false,
        confidence: 0.9,
        ...turn.nlp,
      })
    }

    if (turn.from === 'customer') {
      await handler.handle(inboundText(merchantId, CUSTOMER_PHONE, turn.text))
    } else if (turn.from === 'merchant') {
      await handler.handle(inboundText(merchantId, MERCHANT_PHONE, turn.text))
    } else {
      await handler.handleMessageEcho(echoMsg(merchantId, CUSTOMER_PHONE, turn.text))
    }

    const ex = turn.expect
    if (!ex) continue

    if (ex.nlpNotCalled) {
      const called = analyseMock.mock.calls.length > nlpCallsBefore
      if (called) throw new Error(`${label}: NLP was called but should have been skipped`)
    }

    if (ex.noReply) {
      const sent = repliesTo(natsPublish, callsBefore, CUSTOMER_PHONE)
      if (sent.length > 0)
        throw new Error(`${label}: expected no reply to customer but got: ${JSON.stringify(sent)}`)
    }

    if (ex.botReplied !== undefined) {
      const sent = repliesTo(natsPublish, callsBefore, CUSTOMER_PHONE)
      const hit = sent.some(m =>
        ex.botReplied instanceof RegExp ? ex.botReplied.test(m) : m.includes(ex.botReplied as string)
      )
      if (!hit)
        throw new Error(
          `${label}: expected bot reply matching ${JSON.stringify(ex.botReplied)}\n` +
          `  Actual replies to customer: ${JSON.stringify(sent)}`
        )
    }

    if (ex.merchantNotified !== undefined) {
      const textMessages = repliesTo(natsPublish, callsBefore, MERCHANT_PHONE)
      const allEvents = publishedSince(natsPublish, callsBefore).filter(e => e.to === MERCHANT_PHONE)
      const haystack = [
        ...textMessages,
        ...allEvents.map(e => JSON.stringify(e)),
      ].join('\n')
      const hit =
        ex.merchantNotified instanceof RegExp
          ? ex.merchantNotified.test(haystack)
          : haystack.includes(ex.merchantNotified as string)
      if (!hit)
        throw new Error(
          `${label}: expected merchant notification matching ${JSON.stringify(ex.merchantNotified)}\n` +
          `  Actual merchant messages: ${JSON.stringify(textMessages)}\n` +
          `  All events to merchant: ${JSON.stringify(allEvents)}`
        )
    }

    if (ex.state !== undefined) {
      const conv = await db.query.conversations.findFirst({
        where: eq(conversations.customerPhone, CUSTOMER_PHONE),
      })
      if (conv?.state !== ex.state)
        throw new Error(`${label}: expected state=${ex.state} but got state=${conv?.state}`)
    }

    if (ex.orderCount !== undefined) {
      const all = await db.query.orders.findMany({ where: eq(orders.merchantId, merchantId) })
      if (all.length !== ex.orderCount)
        throw new Error(`${label}: expected ${ex.orderCount} orders but found ${all.length}`)
    }

    if (ex.orderTotal !== undefined) {
      const all = await db.query.orders.findMany({ where: eq(orders.merchantId, merchantId) })
      const actual = parseFloat(all[0]?.total ?? '0')
      if (actual !== ex.orderTotal)
        throw new Error(`${label}: expected orderTotal=${ex.orderTotal} but got ${actual}`)
    }
  }
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

describe('Scenario 1 — PAYMENT_INTENT counter accepted at floor (full happy path)', () => {
  it('handles inquiry → 100k lowball → floor quote → agreement → order at ₦125k', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, {
      name: 'Louis Vuitton Monogram Shirt',
      price: '135000',
      lastPrice: '125000',
    })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I need an lv shirt',
        nlp: { intent: 'INQUIRY', items: [{ productName: 'Louis Vuitton Monogram Shirt', quantity: 1 }] },
        expect: { botReplied: '₦135,000', state: 'NEGOTIATING' },
      },
      {
        // "pay 100k" triggers rawOfferPrice extraction → NLP bypassed
        from: 'customer',
        text: "That's a lot man, let me pay 100k",
        expect: { botReplied: 'I can do ₦125,000 for it.', state: 'NEGOTIATING' },
      },
      {
        from: 'customer',
        text: 'Okay deal',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'No, confirm it',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { orderCount: 1, orderTotal: 125000 },
      },
    ])
  })
})

describe('Scenario 2 — Bot holds floor through repeated lowball offers', () => {
  it('never drops below ₦4,500 no matter how many times customer tries', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'how much for rice?',
        nlp: { intent: 'INQUIRY', items: [{ productName: 'rice', quantity: 1 }] },
        expect: { botReplied: '₦5,000', state: 'NEGOTIATING' },
      },
      {
        // "do 3k" triggers rawOfferPrice extraction (cost gate bypasses NLP)
        from: 'customer',
        text: 'abeg do 3k',
        expect: { botReplied: 'I can do ₦4,500 for it.' },
      },
      {
        // "4k last" also triggers rawOfferPrice extraction — NLP skipped
        from: 'customer',
        text: '4k last',
        expect: { botReplied: 'I can do ₦4,500 for it.' },
      },
      {
        // "oya na 4500" has no price-offer keyword → NLP called with COUNTER_OFFER
        // at floor; accepted=true → agreedPrice=4500 persisted
        from: 'customer',
        text: 'oya na 4500',
        nlp: { intent: 'COUNTER_OFFER', counterOfferPrice: 4500 },
        expect: { botReplied: 'I can do ₦4,500 for it.' },
      },
      {
        from: 'customer',
        text: 'ok',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'confirm',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { orderCount: 1, orderTotal: 4500 },
      },
    ])
  })
})

describe('Scenario 3 — Unknown product escalates to merchant, no order created', () => {
  it('notifies merchant about unknown product', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I want beans',
        nlp: { intent: 'ORDER', items: [{ productName: 'beans', quantity: 1 }] },
        expect: { merchantNotified: /beans/i, orderCount: 0 },
      },
    ])
  })
})

describe('Scenario 4 — Multi-product order', () => {
  it('sums rice + garri into a single confirmed order', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })
    await createProduct(rig.db, merchant.id, { name: 'garri', price: '3000', lastPrice: '2500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I want 2 bags of rice and 1 garri',
        nlp: {
          intent: 'ORDER',
          items: [{ productName: 'rice', quantity: 2 }, { productName: 'garri', quantity: 1 }],
        },
        expect: { botReplied: '₦13,000', state: 'NEGOTIATING' },
      },
      {
        from: 'customer',
        text: 'ok take am',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'no, go ahead',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { orderCount: 1, orderTotal: 13000 },
      },
    ])
  })
})

describe('Scenario 5 — DONE triggers payment review without NLP', () => {
  it('creates pending payment review and sends merchant template', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    const order = await createOrder(rig.db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      status: 'AWAITING_PAYMENT',
      total: '150000',
      subtotal: '150000',
    })
    await createConversation(rig.db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'AWAITING_PAYMENT',
      context: {
        currentItems: [],
        negotiationHistory: [],
        orderId: order.id,
        lastMessageAt: new Date().toISOString(),
      },
    })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'DONE',
        expect: { nlpNotCalled: true },
      },
    ])

    const merchantEvents = publishedSince(rig.natsPublish, 0).filter(e => e.to === MERCHANT_PHONE)
    const gotTemplate = merchantEvents.some(e => {
      const t = e.template as { name?: string } | undefined
      return t?.name === 'mesa_payment_needs_confirmation_v2'
    })
    expect(gotTemplate).toBe(true)

    const reviewTask = await rig.pending.get(merchant.id, 'PENDING_PAYMENT_REVIEW')
    expect(reviewTask).not.toBeNull()
  })
})

describe('Scenario 6 — Assist mode: merchant confirms with YES', () => {
  it('creates order only after merchant says YES', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, {
      phone: MERCHANT_PHONE,
      config: { bot: { enabled: false } },
    })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000' })

    // Turn 1: customer orders (assist mode — bot doesn't reply)
    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 3, unitPrice: 5000 }],
      agreementSignalDetected: true,
      confidence: 0.9,
    })
    await rig.handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want 3 bags of rice please'))

    // In production, NATS delivers ORDER_DETECTED to OrderHandler. In tests we do it inline.
    const detectedEvent = rig.natsPublish.mock.calls
      .map(c => c[0] as Record<string, unknown>)
      .find(e => e.subject === 'mesa.order.detected') as OrderDetectedEvent | undefined
    expect(detectedEvent).toBeDefined()
    await rig.orderHandler.handleDetected(detectedEvent!)

    // Pending decision created, no order yet
    const pendingBefore = await rig.pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(pendingBefore).not.toBeNull()
    const ordersBefore = await rig.db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(ordersBefore).toHaveLength(0)

    // Turn 2: merchant says YES → order created
    await rig.handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'yes'))
    const ordersAfter = await rig.db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(ordersAfter).toHaveLength(1)
    expect(parseFloat(ordersAfter[0].total)).toBe(15000)
  })
})

describe('Scenario 7 — Assist mode: merchant rejects with NO', () => {
  it('cancels pending decision, no order created', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, {
      phone: MERCHANT_PHONE,
      config: { bot: { enabled: false } },
    })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000' })

    // Turn 1: customer orders
    analyseMock.mockResolvedValueOnce({
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 2, unitPrice: 5000 }],
      agreementSignalDetected: true,
      confidence: 0.9,
    })
    await rig.handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want 2 bags of rice'))

    // Simulate ORDER_DETECTED → creates pending decision
    const detectedEvent = rig.natsPublish.mock.calls
      .map(c => c[0] as Record<string, unknown>)
      .find(e => e.subject === 'mesa.order.detected') as OrderDetectedEvent | undefined
    expect(detectedEvent).toBeDefined()
    await rig.orderHandler.handleDetected(detectedEvent!)

    // Turn 2: merchant says NO → pending cancelled, no order
    await rig.handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'no'))
    const allOrders = await rig.db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(allOrders).toHaveLength(0)

    const stillOpen = await rig.pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(stillOpen).toBeNull()
  })
})

describe('Scenario 8 — Pidgin/informal language throughout', () => {
  it('handles full pidgin negotiation for a wig', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, {
      name: 'Bone Straight Wig',
      price: '180000',
      lastPrice: '165000',
    })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'abeg how much be the wig wey you post',
        nlp: { intent: 'INQUIRY', items: [{ productName: 'Bone Straight Wig', quantity: 1 }] },
        expect: { botReplied: '₦180,000', state: 'NEGOTIATING' },
      },
      {
        // "do 150k" triggers rawOfferPrice extraction → NLP bypassed
        from: 'customer',
        text: 'e too much na, I go do 150k',
        expect: { botReplied: 'I can do ₦165,000 for it.' },
      },
      {
        from: 'customer',
        text: 'oya I go manage am',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'no, confirm am',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { orderCount: 1, orderTotal: 165000 },
      },
    ])
  })
})

describe('Scenario 9 — Bare greeting skips NLP, next order message is processed', () => {
  it('does not call NLP on "Hello" but processes the following order', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'Hello',
        expect: { nlpNotCalled: true, noReply: true },
      },
      {
        from: 'customer',
        text: 'I want rice',
        nlp: { intent: 'ORDER', items: [{ productName: 'rice', quantity: 1 }] },
        expect: { botReplied: '₦5,000' },
      },
    ])
  })
})

describe('Scenario 10 — "Acc details" treated as agreement not another price quote', () => {
  it('creates order immediately without sending the floor price again', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    const product = await createProduct(rig.db, merchant.id, {
      name: 'Louis Vuitton Monogram Shirt',
      price: '135000',
      lastPrice: '125000',
    })
    await createConversation(rig.db, merchant.id, {
      customerPhone: CUSTOMER_PHONE,
      state: 'NEGOTIATING',
      context: {
        currentItems: [{
          productId: product.id,
          productName: 'Louis Vuitton Monogram Shirt',
          quantity: 1,
          unitPrice: 135000,
          floorUnitPrice: 125000,
          agreedPrice: 125000,
        }],
        negotiationHistory: [],
        lastQuotedPrice: 125000,
        minimumAcceptableTotal: 125000,
        agreedPrice: 125000,
        lastMessageAt: new Date().toISOString(),
      },
    })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'Acc details',
        nlp: { intent: 'PAYMENT_INTENT', lastMentionedPrice: 125000 },
        expect: { orderCount: 1, orderTotal: 125000 },
      },
    ])

    const toCustomer = repliesTo(rig.natsPublish, 0, CUSTOMER_PHONE)
    expect(toCustomer).not.toContain('I can do ₦125,000 for it.')
  })
})

describe('Scenario 11 — Merchant echo pauses automation, customer message stored silently', () => {
  it('sets automationPausedUntil and skips NLP on subsequent non-commerce message', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createConversation(rig.db, merchant.id, { customerPhone: CUSTOMER_PHONE })

    await rig.handler.handleMessageEcho(echoMsg(merchant.id, CUSTOMER_PHONE, 'I will handle this one'))

    const conv = await rig.db.query.conversations.findFirst({
      where: eq(conversations.customerPhone, CUSTOMER_PHONE),
    })
    const ctx = conv?.context as { automationPausedUntil?: string }
    expect(ctx.automationPausedUntil).toBeDefined()
    expect(new Date(ctx.automationPausedUntil!).getTime()).toBeGreaterThan(Date.now())

    analyseMock.mockReset()
    await rig.handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'thanks'))
    expect(analyseMock).not.toHaveBeenCalled()

    const toCustomer = repliesTo(rig.natsPublish, 0, CUSTOMER_PHONE)
    expect(toCustomer).toHaveLength(0)
  })
})

describe('Scenario 12 — Coexistence: customer inquiry → merchant echo price → customer agrees', () => {
  it('captures order at the merchant-quoted price after echo + agreement', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, {
      phone: MERCHANT_PHONE,
      config: { bot: { enabled: false } },
    })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'how much for rice?',
        nlp: { intent: 'INQUIRY', items: [{ productName: 'rice', quantity: 1 }] },
      },
      {
        from: 'echo',
        text: '₦5000',
      },
      {
        from: 'customer',
        text: 'ok',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
      },
    ])

    const orderDetected = publishedSince(rig.natsPublish, 0).some(
      e => e.subject === 'mesa.order.detected' && (e as { agreedTotal?: number }).agreedTotal === 5000
    )
    expect(orderDetected).toBe(true)
  })
})

describe('Scenario 13 — "Last price" query returns floor, not another ask', () => {
  it('replies with floor when customer asks for last/best price after a counter', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'how much for rice?',
        nlp: { intent: 'INQUIRY', items: [{ productName: 'rice', quantity: 1 }] },
        expect: { botReplied: '₦5,000' },
      },
      {
        // rawOfferPrice bypass — NLP skipped
        from: 'customer',
        text: 'abeg do 3k',
        expect: { botReplied: 'I can do ₦4,500 for it.' },
      },
      {
        // CHEAP_RULES: "last price" keyword pattern
        from: 'customer',
        text: 'wetin be your last price?',
        expect: { botReplied: '₦4,500 is the best I can do.' },
      },
    ])
  })
})

describe('Scenario 14 — Item correction mid-order: customer swaps product', () => {
  it('removes old item, asks for quantity, then re-quotes the corrected item', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })
    await createProduct(rig.db, merchant.id, { name: 'garri', price: '3000', lastPrice: '2500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I want rice',
        nlp: { intent: 'ORDER', items: [{ productName: 'rice', quantity: 1 }] },
        expect: { botReplied: '₦5,000' },
      },
      {
        // CATALOG_RULES: "not" keyword without digits → cheap correction path.
        // Garri has no quantity yet → bot asks how many.
        from: 'customer',
        text: 'not rice, garri',
        expect: { botReplied: /how many garri/i },
      },
      {
        // CHEAP_RULES: bare number → quantity-only update → re-quote garri
        from: 'customer',
        text: '1',
        expect: { botReplied: '₦3,000' },
      },
      {
        from: 'customer',
        text: 'yes',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'confirm',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { orderCount: 1, orderTotal: 3000 },
      },
    ])
  })
})

describe('Scenario 15 — Customer adds item then confirms: add garri to rice order', () => {
  it('merges new item and re-quotes total when customer adds while in AGREED', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })
    await createProduct(rig.db, merchant.id, { name: 'garri', price: '3000', lastPrice: '2500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I want rice',
        nlp: { intent: 'ORDER', items: [{ productName: 'rice', quantity: 1 }] },
        expect: { botReplied: '₦5,000' },
      },
      {
        from: 'customer',
        text: 'ok',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'yes add garri',
        nlp: { intent: 'ORDER', items: [{ productName: 'garri', quantity: 1 }] },
        expect: { botReplied: '₦8,000', state: 'NEGOTIATING' },
      },
      {
        from: 'customer',
        text: 'confirm',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'yes confirm',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { orderCount: 1, orderTotal: 8000 },
      },
    ])
  })
})

describe('Scenario 16 — Delivery address acknowledged, order proceeds', () => {
  it('bot confirms address then creates order on second agreement', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I want rice',
        nlp: { intent: 'ORDER', items: [{ productName: 'rice', quantity: 1 }] },
        expect: { botReplied: '₦5,000' },
      },
      {
        // CHEAP_RULES: "deliver to X" pattern → ACKNOWLEDGE_DELIVERY_ADDRESS
        from: 'customer',
        text: 'deliver to 12 Allen Avenue Ikeja',
        expect: { botReplied: /Got it.*12 Allen Avenue Ikeja/i },
      },
      {
        from: 'customer',
        text: 'ok',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'confirm',
        nlp: { intent: 'AGREEMENT', agreementSignalDetected: true },
        expect: { orderCount: 1, orderTotal: 5000 },
      },
    ])
  })
})

describe('Scenario 17 — Clothing flow: broad opener, last price, then add sneakers', () => {
  it('answers broad clothing intent naturally and does not let last-price state poison the next product', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'Plain White Polo Shirt', price: '8500', lastPrice: '8500' })
    await createProduct(rig.db, merchant.id, { name: 'Plain Black Polo Shirt', price: '8500', lastPrice: '8500' })
    await createProduct(rig.db, merchant.id, { name: 'Striped Casual Shirt', price: '12000', lastPrice: '12000' })
    await createProduct(rig.db, merchant.id, { name: 'Ankara Print Shirt', price: '14000', lastPrice: '12000' })
    await createProduct(rig.db, merchant.id, { name: 'Graphic Tee', price: '7500', lastPrice: '7500' })
    await createProduct(rig.db, merchant.id, { name: 'Sneakers', price: '20000', lastPrice: '20000' })

    salesReplyMock.mockResolvedValueOnce({
      message: 'Sure, we have shirts and sneakers available. What kind of clothes are you looking for?',
      modelUsed: 'haiku',
    })
    salesReplyMock.mockResolvedValueOnce({
      message: 'Sure, we can help with clothes. Are you looking for shirts, tees, or something else?',
      modelUsed: 'haiku',
    })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'Hi, I will like to buy some cloths',
        nlp: { intent: 'ORDER', items: [] },
        expect: { botReplied: /shirts and sneakers/i },
      },
      {
        from: 'customer',
        text: 'I will like to buy a shirt',
        nlp: { intent: 'INQUIRY', items: [] },
        expect: { botReplied: /Ankara Print Shirt/ },
      },
      {
        from: 'customer',
        text: 'The Ankara print',
        nlp: { intent: 'ORDER', items: [{ productName: 'Ankara Print Shirt', quantity: 1 }] },
        expect: { botReplied: '₦14,000' },
      },
      {
        from: 'customer',
        text: "What's the last price",
        expect: { botReplied: '₦12,000 is the best I can do.' },
      },
      {
        from: 'customer',
        text: 'I need a sneakers too',
        nlp: { intent: 'ORDER', items: [{ productName: 'Sneakers', quantity: 1 }] },
        expect: { botReplied: /₦34,000/ },
      },
      {
        from: 'customer',
        text: 'I want to buy cloths',
        nlp: { intent: 'ORDER', items: [] },
        expect: { botReplied: /looking for shirts/i },
      },
    ])

    const allCustomerReplies = repliesTo(rig.natsPublish, 0, CUSTOMER_PHONE)
    const finalReply = allCustomerReplies.at(-1) ?? ''
    expect(finalReply).not.toMatch(/best I can do/i)
    expect(salesReplyMock).toHaveBeenCalledTimes(2)
  })
})

describe('Scenario 18 — Clothing removal: remove polo from mixed basket', () => {
  it('removes polo by partial name and re-quotes the remaining basket only', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'Plain White Polo Shirt', aliases: ['polo'], price: '8500', lastPrice: '8500' })
    await createProduct(rig.db, merchant.id, { name: 'Sneakers', price: '22000', lastPrice: '22000' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I want polo and sneakers',
        nlp: {
          intent: 'ORDER',
          items: [
            { productName: 'Plain White Polo Shirt', quantity: 1 },
            { productName: 'Sneakers', quantity: 1 },
          ],
        },
        expect: { botReplied: '₦30,500' },
      },
      {
        from: 'customer',
        text: 'Remove polo',
        expect: { botReplied: '₦22,000' },
      },
    ])

    const allCustomerReplies = repliesTo(rig.natsPublish, 0, CUSTOMER_PHONE)
    const finalReply = allCustomerReplies.at(-1) ?? ''
    expect(finalReply).not.toContain('₦30,500')
    expect(finalReply).not.toContain('₦41,500')
  })
})
