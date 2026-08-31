import { eq, sql } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { agentTasks, notificationFailures } from '@mesa/db'
import { orderRoutes } from '../../src/routes/orders'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createOrder, createConversation, createFulfilment } from '@test-helpers/factories'
import { createSessionHeaders, internalAuthHeaders } from '@test-helpers/auth'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(orderRoutes, { prefix: '/orders' })
  return app
}

describe('GET /orders (integration)', () => {
  it('returns the merchant orders, newest first', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const first = await createOrder(db, merchant.id, { total: '1000' })
    // Small delay so the second order has a later createdAt.
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await createOrder(db, merchant.id, { total: '2000' })

    const res = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { orders: Array<{ id: string }> }
    expect(body.orders).toHaveLength(2)
    expect(body.orders[0].id).toBe(second.id)
    expect(body.orders[1].id).toBe(first.id)
  })

  it('includes the source conversation channel so the dashboard can badge Instagram vs WhatsApp orders', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: 'igsid_customer_1' })
    await createOrder(db, merchant.id, { total: '1000', conversationId: conv.id, customerPhone: 'igsid_customer_1' })

    const res = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { orders: Array<{ conversation?: { channel: string } }> }
    expect(body.orders[0].conversation?.channel).toBe('instagram')
  })

  it('rejects a browser session requesting another merchant orders', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)
    await createOrder(db, merchantB.id)

    const res = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchantB.id}`,
      headers: await createSessionHeaders(db, merchantA.id),
    })

    expect(res.statusCode).toBe(403)
  })

  it('allows internal callers to request explicit merchant orders', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createOrder(db, merchant.id)

    const res = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchant.id}`,
      headers: internalAuthHeaders(),
    })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { orders: unknown[] }).orders).toHaveLength(1)
  })
})

describe('GET /orders — date range and limit (dashboard "Custom" date filter)', () => {
  async function lagosToday(db: ReturnType<typeof getTestDb>): Promise<string> {
    const result = await db.execute(sql`SELECT (now() AT TIME ZONE 'Africa/Lagos')::date AS today`)
    const row = (result as unknown as { rows: Array<{ today: string }> }).rows[0]
    return row.today
  }

  function addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00.000Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }

  it('rejects malformed dates and a from-after-to range', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const headers = await createSessionHeaders(db, merchant.id)

    const malformed = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchant.id}&from=not-a-date&to=2026-01-01`,
      headers,
    })
    expect(malformed.statusCode).toBe(400)

    const reversed = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchant.id}&from=2026-02-10&to=2026-02-01`,
      headers,
    })
    expect(reversed.statusCode).toBe(400)
  })

  it('scopes results to a from/to range using Lagos calendar days, excluding orders outside it', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const today = await lagosToday(db)
    const twoDaysAgo = addDays(today, -2)
    const threeDaysAgo = addDays(today, -3)

    const inRange = await createOrder(db, merchant.id, {
      total: '1000',
      createdAt: new Date(`${twoDaysAgo}T12:00:00.000Z`),
    })
    const outsideRange = await createOrder(db, merchant.id, {
      total: '2000',
      createdAt: new Date(`${threeDaysAgo}T12:00:00.000Z`),
    })

    const res = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchant.id}&from=${twoDaysAgo}&to=${today}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { orders: Array<{ id: string }> }
    const ids = body.orders.map(o => o.id)
    expect(ids).toContain(inRange.id)
    expect(ids).not.toContain(outsideRange.id)
  })

  it('honors an explicit limit instead of silently capping at 50', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    for (let i = 0; i < 60; i++) {
      await createOrder(db, merchant.id, { total: '500' })
    }

    const capped = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect((capped.json() as { orders: unknown[] }).orders).toHaveLength(50)

    const raised = await app.inject({
      method: 'GET',
      url: `/orders?merchantId=${merchant.id}&limit=60`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect((raised.json() as { orders: unknown[] }).orders).toHaveLength(60)
  })
})

describe('GET /orders/pending — F-4 regression', () => {
  it('returns only OPEN pending-decision tasks for the merchant', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await db.insert(agentTasks).values([
      {
        merchantId: merchant.id,
        type: 'PENDING_ORDER_CONFIRMATION',
        status: 'OPEN',
        payload: { conversationId: 'c1', agreedTotal: 1000 },
      },
      {
        merchantId: merchant.id,
        type: 'PENDING_PAYMENT_REVIEW',
        status: 'OPEN',
        payload: { orderId: 'o1', reason: 'low_confidence' },
      },
      {
        merchantId: merchant.id,
        type: 'PENDING_ORDER_CONFIRMATION',
        status: 'DONE', // should be filtered out
        payload: { conversationId: 'c2' },
      },
      {
        merchantId: merchant.id,
        type: 'ONBOARDING_FOLLOWUP', // wrong type — filtered out
        status: 'OPEN',
        payload: {},
      },
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/orders/pending?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { pending: Array<{ type: string; status: string }> }
    expect(body.pending).toHaveLength(2)
    expect(body.pending.every(t => t.status === 'OPEN')).toBe(true)
    expect(body.pending.map(t => t.type).sort()).toEqual([
      'PENDING_ORDER_CONFIRMATION',
      'PENDING_PAYMENT_REVIEW',
    ])
  })

  it('returns 400 when merchantId is missing', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const res = await app.inject({
      method: 'GET',
      url: '/orders/pending',
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /orders/notifications/failures — F-13 regression', () => {
  it('returns unresolved failures for the merchant', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await db.insert(notificationFailures).values([
      {
        merchantId: merchant.id,
        channel: 'whatsapp',
        recipient: '+2348011112222',
        message: 'failed message',
        errorMessage: 'Meta 401',
      },
      {
        merchantId: merchant.id,
        channel: 'whatsapp',
        recipient: '+2348011112222',
        message: 'resolved one',
        errorMessage: 'transient',
        resolvedAt: new Date(),
      },
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/orders/notifications/failures?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { failures: Array<{ errorMessage: string }> }
    expect(body.failures).toHaveLength(1)
    expect(body.failures[0].errorMessage).toBe('Meta 401')
  })
})

describe('GET /orders/:id', () => {
  it('returns the order with items and payments', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)

    const res = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { order: { id: string; items: unknown[]; payments: unknown[] } }
    expect(body.order.id).toBe(order.id)
    expect(Array.isArray(body.order.items)).toBe(true)
    expect(Array.isArray(body.order.payments)).toBe(true)
  })

  it('includes the source conversation channel', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, { channel: 'instagram', customerPhone: 'igsid_customer_1' })
    const order = await createOrder(db, merchant.id, { conversationId: conv.id, customerPhone: 'igsid_customer_1' })

    const res = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { order: { conversation?: { channel: string } } }
    expect(body.order.conversation?.channel).toBe('instagram')
  })

  it('hides another merchant order from a browser session', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)
    const order = await createOrder(db, merchantB.id)

    const res = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: await createSessionHeaders(db, merchantA.id),
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for an unknown order id', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/orders/00000000-0000-0000-0000-000000000000',
      headers: internalAuthHeaders(),
    })
    expect(res.statusCode).toBe(404)
  })

  it('includes the fulfilment (delivery address + contact phone) so the dashboard can show it', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    await createFulfilment(db, order.id, merchant.id, {
      dropoffAddress: '12 Admiralty Way, Lekki Phase 1',
      contactPhone: '+2348011112222',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { order: { fulfilments: Array<{ dropoffAddress: string; contactPhone: string }> } }
    expect(body.order.fulfilments).toHaveLength(1)
    expect(body.order.fulfilments[0].dropoffAddress).toBe('12 Admiralty Way, Lekki Phase 1')
    expect(body.order.fulfilments[0].contactPhone).toBe('+2348011112222')
  })

  it('returns an empty fulfilments array when the order has no fulfilment yet', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)

    const res = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { order: { fulfilments: unknown[] } }
    expect(body.order.fulfilments).toEqual([])
  })
})
