import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { config } from '@mesa/config'
import { fulfilments, orders } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { webhookRoutes } from '../../src/routes/webhooks'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation } from '@test-helpers/factories'

jest.mock('@mesa/whatsapp', () => ({
  sendText: jest.fn(),
}))

setupIntegration()

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(webhookRoutes, { prefix: '/webhooks' })
  apps.push(app)
  return app
}

async function seedBookedFulfilment(db: ReturnType<typeof getTestDb>) {
  const merchant = await createMerchant(db)
  const conv = await createConversation(db, merchant.id, { customerPhone: '+2348099998888' })
  const [order] = await db.insert(orders).values({
    merchantId: merchant.id,
    conversationId: conv.id,
    customerPhone: '+2348099998888',
    status: 'PAID',
    subtotal: '20000',
    total: '20000',
  }).returning()
  const [fulfilment] = await db.insert(fulfilments).values({
    merchantId: merchant.id,
    orderId: order.id,
    customerPhone: '+2348099998888',
    status: 'BOOKED',
    mode: 'BOOK_RIDER',
    provider: 'FEZ',
    providerOrderId: 'fez_order_123',
  }).returning()
  return fulfilment
}

describe('FEZ webhook route', () => {
  it('rejects requests with a missing or wrong x-fez-webhook-secret header', async () => {
    const app = await buildApp()

    const missing = await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'order.status_changed', data: { orderNumber: 'fez_order_123', orderStatus: 'in_transit' } }),
    })
    expect(missing.statusCode).toBe(401)

    const wrong = await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json', 'x-fez-webhook-secret': 'not-it' },
      payload: JSON.stringify({ event: 'order.status_changed', data: { orderNumber: 'fez_order_123', orderStatus: 'in_transit' } }),
    })
    expect(wrong.statusCode).toBe(401)
  })

  it('updates the matching fulfilment by (provider, providerOrderId) and maps the raw status to the Mesa enum', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const fulfilment = await seedBookedFulfilment(db)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json', 'x-fez-webhook-secret': config.FEZ_WEBHOOK_SECRET! },
      payload: JSON.stringify({
        event: 'order.status_changed',
        data: { orderNumber: 'fez_order_123', orderStatus: 'in_transit', trackingUrl: 'https://fez.test/track/123' },
      }),
    })

    expect(res.statusCode).toBe(200)
    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('IN_TRANSIT')
    expect(refreshed?.providerStatus).toBe('in_transit')
    expect(refreshed?.trackingUrl).toBe('https://fez.test/track/123')
  })

  it('replaying the identical event is a no-op (idempotent)', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const fulfilment = await seedBookedFulfilment(db)
    const send = () => app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json', 'x-fez-webhook-secret': config.FEZ_WEBHOOK_SECRET! },
      payload: JSON.stringify({ event: 'order.status_changed', data: { orderNumber: 'fez_order_123', orderStatus: 'delivered' } }),
    })

    const first = await send()
    const second = await send()
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('DELIVERED')
  })

  it('an unrecognized raw status updates providerStatus for visibility but does not move the Mesa status backwards/sideways', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const fulfilment = await seedBookedFulfilment(db)

    await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json', 'x-fez-webhook-secret': config.FEZ_WEBHOOK_SECRET! },
      payload: JSON.stringify({ event: 'order.status_changed', data: { orderNumber: 'fez_order_123', orderStatus: 'rider_en_route' } }),
    })

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('BOOKED')
    expect(refreshed?.providerStatus).toBe('rider_en_route')
  })

  it('ignores an event with no orderNumber rather than erroring', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json', 'x-fez-webhook-secret': config.FEZ_WEBHOOK_SECRET! },
      payload: JSON.stringify({ event: 'order.status_changed', data: { orderStatus: 'delivered' } }),
    })

    expect(res.statusCode).toBe(200)
  })
})
