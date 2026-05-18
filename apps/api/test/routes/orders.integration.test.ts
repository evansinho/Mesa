import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { agentTasks, notificationFailures } from '@mesa/db'
import { orderRoutes } from '../../src/routes/orders'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createOrder } from '@test-helpers/factories'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.decorate('db', getTestDb())
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
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { orders: Array<{ id: string }> }
    expect(body.orders).toHaveLength(2)
    expect(body.orders[0].id).toBe(second.id)
    expect(body.orders[1].id).toBe(first.id)
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
    const res = await app.inject({ method: 'GET', url: '/orders/pending' })
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
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { order: { id: string; items: unknown[]; payments: unknown[] } }
    expect(body.order.id).toBe(order.id)
    expect(Array.isArray(body.order.items)).toBe(true)
    expect(Array.isArray(body.order.payments)).toBe(true)
  })

  it('returns 404 for an unknown order id', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/orders/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(404)
  })
})
