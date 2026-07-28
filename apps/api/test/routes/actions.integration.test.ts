import { createHash, randomBytes } from 'crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { agentTasks, domainEvents, orders, payments } from '@mesa/db'
import { actionRoutes } from '../../src/routes/actions'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createOrder, createPayment } from '@test-helpers/factories'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  await app.register(actionRoutes, { prefix: '/actions' })
  return app
}

function makeToken(): { token: string; hash: string } {
  const token = randomBytes(16).toString('hex')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

// Regression: the ON CONFLICT `where` predicate on these domainEvents inserts
// must exactly match domain_events_appendonce_idx's actual current predicate
// (migration 0022 dropped ORDER_DETECTED from it) — Postgres rejects the
// whole insert with "there is no unique or exclusion constraint matching the
// ON CONFLICT specification" if the predicate doesn't match verbatim, not
// just when a real conflict occurs. This shipped to production undetected
// because this file had zero test coverage before now.
describe('POST /actions/order/:token/accept — domainEvents ON CONFLICT regression', () => {
  it('confirms the order without throwing on the domainEvents insert', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const { token, hash } = makeToken()
    await db.insert(agentTasks).values({
      merchantId: merchant.id,
      type: 'PENDING_ORDER_CONFIRMATION',
      status: 'OPEN',
      actionTokenHash: hash,
      payload: {
        customerPhone: '+2348011112222',
        items: [{ productName: 'rice', quantity: 2, unitPrice: 2500, agreedPrice: 2500 }],
        agreedTotal: 5000,
      },
    })

    const res = await app.inject({ method: 'POST', url: `/actions/order/${token}/accept` })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; orderId: string }
    expect(body.ok).toBe(true)

    const order = await db.query.orders.findFirst({ where: eq(orders.id, body.orderId) })
    expect(order?.status).toBe('CONFIRMED')

    const event = await db.query.domainEvents.findFirst({
      where: eq(domainEvents.aggregateId, body.orderId),
    })
    expect(event?.eventType).toBe('ORDER_CONFIRMED')
  })

  it('a second accept on an already-actioned task 409s instead of throwing', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const { token, hash } = makeToken()
    await db.insert(agentTasks).values({
      merchantId: merchant.id,
      type: 'PENDING_ORDER_CONFIRMATION',
      status: 'OPEN',
      actionTokenHash: hash,
      payload: { customerPhone: '+2348011112222', items: [], agreedTotal: 5000 },
    })

    const first = await app.inject({ method: 'POST', url: `/actions/order/${token}/accept` })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({ method: 'POST', url: `/actions/order/${token}/accept` })
    expect(second.statusCode).toBe(409)
  })
})

describe('POST /actions/payment/:token/confirm — domainEvents ON CONFLICT regression', () => {
  it('confirms the payment without throwing on the domainEvents insert', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })
    const payment = await createPayment(db, order.id, merchant.id, { status: 'PENDING', amount: '5000' })
    const { token, hash } = makeToken()
    await db.insert(agentTasks).values({
      merchantId: merchant.id,
      type: 'PENDING_PAYMENT_REVIEW',
      status: 'OPEN',
      actionTokenHash: hash,
      payload: { orderId: order.id, reason: 'low_confidence', received: 5000, expected: 5000 },
    })

    const res = await app.inject({ method: 'POST', url: `/actions/payment/${token}/confirm` })

    expect(res.statusCode).toBe(200)

    const refreshedPayment = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) })
    expect(refreshedPayment?.status).toBe('CONFIRMED')

    const event = await db.query.domainEvents.findFirst({
      where: eq(domainEvents.aggregateId, order.id),
    })
    expect(event?.eventType).toBe('PAYMENT_CONFIRMED')
  })

  it('a second PENDING payment on the same order hits the real ON CONFLICT no-op path, not just the payment-not-found guard', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })
    // Two separate PENDING payments against the same order — e.g. a first
    // proof that failed OCR review, then a second one submitted for the same
    // order. Both confirmations target the same (aggregateId, eventType)
    // domainEvents row, so the second insert must actually reach the ON
    // CONFLICT branch (not skip it via the `if (payment)` not-found guard).
    await createPayment(db, order.id, merchant.id, { status: 'PENDING', amount: '5000' })

    const first = makeToken()
    await db.insert(agentTasks).values({
      merchantId: merchant.id,
      type: 'PENDING_PAYMENT_REVIEW',
      status: 'OPEN',
      actionTokenHash: first.hash,
      payload: { orderId: order.id, reason: 'low_confidence' },
    })
    const firstRes = await app.inject({ method: 'POST', url: `/actions/payment/${first.token}/confirm` })
    expect(firstRes.statusCode).toBe(200)

    await createPayment(db, order.id, merchant.id, { status: 'PENDING', amount: '5000' })
    const second = makeToken()
    await db.insert(agentTasks).values({
      merchantId: merchant.id,
      type: 'PENDING_PAYMENT_REVIEW',
      status: 'OPEN',
      actionTokenHash: second.hash,
      payload: { orderId: order.id, reason: 'reference_reused' },
    })
    const secondRes = await app.inject({ method: 'POST', url: `/actions/payment/${second.token}/confirm` })
    expect(secondRes.statusCode).toBe(200)

    const events = await db.query.domainEvents.findMany({ where: eq(domainEvents.aggregateId, order.id) })
    expect(events.filter(e => e.eventType === 'PAYMENT_CONFIRMED')).toHaveLength(1)
  })
})
