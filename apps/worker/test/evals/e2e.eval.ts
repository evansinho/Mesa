// Mesa E2E Evaluation Suite — real Claude Haiku, real DB, no NLP mocks
// Run with: MESA_RUN_E2E_EVALS=1 ANTHROPIC_API_KEY=<key> pnpm --filter @mesa/worker exec jest --testPathPatterns="e2e.eval"

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
import { createMerchant, createProduct } from '@test-helpers/factories'

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY must be set to run E2E evals')
}

// Real API calls per turn — allow 2 minutes per scenario
jest.setTimeout(120_000)

setupIntegration()
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

type TurnExpect = {
  botReplied?: string | RegExp
  merchantNotified?: string | RegExp
  state?: string
  orderCount?: number
  orderTotal?: number
  noReply?: boolean
}

type Turn = {
  from: 'customer' | 'merchant'
  text: string
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
    const label = `Turn ${i + 1} ("${turn.text}")`

    if (turn.from === 'customer') {
      await handler.handle(inboundText(merchantId, CUSTOMER_PHONE, turn.text))
    } else {
      await handler.handle(inboundText(merchantId, MERCHANT_PHONE, turn.text))
    }

    const ex = turn.expect
    if (!ex) continue

    if (ex.noReply) {
      const sent = repliesTo(natsPublish, callsBefore, CUSTOMER_PHONE)
      if (sent.length > 0)
        throw new Error(`${label}: expected no reply but got:\n  ${JSON.stringify(sent)}`)
    }

    if (ex.botReplied !== undefined) {
      const sent = repliesTo(natsPublish, callsBefore, CUSTOMER_PHONE)
      const hit = sent.some(m =>
        ex.botReplied instanceof RegExp ? ex.botReplied.test(m) : m.includes(ex.botReplied as string)
      )
      if (!hit)
        throw new Error(
          `${label}: expected bot reply matching ${JSON.stringify(ex.botReplied)}\n` +
          `  Actual replies: ${JSON.stringify(sent)}`
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
          `  Actual: ${JSON.stringify(textMessages)}\n` +
          `  All events: ${JSON.stringify(allEvents)}`
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

describe('E2E 1 — English order: inquiry → agreement → order created', () => {
  it('quotes asking price and creates order when customer agrees', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I want 2 bags of rice',
        expect: { botReplied: /₦10,000/, state: 'NEGOTIATING' },
      },
      {
        from: 'customer',
        text: 'Okay deal',
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'confirm',
        expect: { orderCount: 1, orderTotal: 10000 },
      },
    ])
  })
})

describe('E2E 2 — Negotiation: bot holds floor through repeated lowball offers', () => {
  it('quotes floor on every lowball and creates order at ₦4,500', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000', lastPrice: '4500' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'How much for rice?',
        expect: { botReplied: /₦5,000/ },
      },
      {
        // "do 3k" → rawOfferPrice extraction bypasses Claude → floor quoted
        from: 'customer',
        text: 'abeg do 3k',
        expect: { botReplied: /₦4,500/ },
      },
      {
        // "4k last" → rawOfferPrice extraction bypasses Claude → floor quoted
        from: 'customer',
        text: '4k last',
        expect: { botReplied: /₦4,500/ },
      },
      {
        from: 'customer',
        text: 'okay fine, I agree',
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'confirm',
        expect: { orderCount: 1, orderTotal: 4500 },
      },
    ])
  })
})

describe('E2E 3 — Pidgin: inquiry → do price → manage am → confirm', () => {
  it('processes pidgin negotiation and creates order at floor price', async () => {
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
        text: 'abeg how much be the bone straight wig',
        expect: { botReplied: /₦180,000/ },
      },
      {
        // "I go do 150k" → rawOfferPrice extraction bypasses Claude → floor quoted
        from: 'customer',
        text: 'I go do 150k',
        expect: { botReplied: /₦165,000/ },
      },
      {
        from: 'customer',
        text: 'oya I go manage am',
        expect: { botReplied: /add anything else/i },
      },
      {
        from: 'customer',
        text: 'confirm am',
        expect: { orderCount: 1, orderTotal: 165000 },
      },
    ])
  })
})

describe('E2E 4 — Unknown product: escalates to merchant, no order created', () => {
  it('notifies merchant about unrecognised product', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, { phone: MERCHANT_PHONE })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000' })

    await runTurns(rig, merchant.id, [
      {
        from: 'customer',
        text: 'I want 5 cartons of noodles',
        expect: { merchantNotified: /unknown product/i, orderCount: 0 },
      },
    ])
  })
})

describe('E2E 5 — Customer orders then agrees, merchant confirms with YES', () => {
  it('creates order at catalog price after merchant approval', async () => {
    const rig = build()
    const merchant = await createMerchant(rig.db, {
      phone: MERCHANT_PHONE,
      config: {},
    })
    await createProduct(rig.db, merchant.id, { name: 'rice', price: '5000' })

    // Turn 1: customer states intent — just stores items
    await rig.handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'I want 3 bags of rice'))

    // Turn 2: customer confirms — real Claude classifies as AGREEMENT →
    // handleAgreement looks up catalog price (₦5,000 × 3 = ₦15,000) → ORDER_DETECTED
    await rig.handler.handle(inboundText(merchant.id, CUSTOMER_PHONE, 'Okay deal'))

    // In production NATS delivers ORDER_DETECTED to OrderHandler; wire it inline in tests
    const detectedEvent = rig.natsPublish.mock.calls
      .map(c => c[0] as Record<string, unknown>)
      .find(e => e.subject === 'mesa.order.detected') as OrderDetectedEvent | undefined
    expect(detectedEvent).toBeDefined()
    await rig.orderHandler.handleDetected(detectedEvent!)

    // Pending decision created, no order yet
    const pending = await rig.pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(pending).not.toBeNull()
    const before = await rig.db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(before).toHaveLength(0)

    // Merchant confirms → order created at ₦15,000
    await rig.handler.handle(inboundText(merchant.id, MERCHANT_PHONE, 'yes'))
    const after = await rig.db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(after).toHaveLength(1)
    expect(parseFloat(after[0].total)).toBe(15000)
  })
})
