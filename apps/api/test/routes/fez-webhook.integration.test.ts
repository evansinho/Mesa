import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
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

// Verified via the call-time `config.FEZ_SECRET_KEY ?? process.env.FEZ_SECRET_KEY`
// fallback in webhooks.ts (same pattern the fez.ts adapter uses) — set here
// per-test rather than in .env.test, so this test doesn't depend on (or
// accidentally regress) whatever FEZ_SECRET_KEY the adapter's own unit
// tests expect to be unset.
const originalSecretKey = process.env.FEZ_SECRET_KEY
beforeEach(() => {
  process.env.FEZ_SECRET_KEY = 'test-fez-secret'
})
afterAll(() => {
  if (originalSecretKey === undefined) delete process.env.FEZ_SECRET_KEY
  else process.env.FEZ_SECRET_KEY = originalSecretKey
})

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

// Mirrors verifyFezSignature in src/routes/webhooks.ts: HMAC-SHA256 of
// (orderNumber + status + timestamp), keyed with FEZ_SECRET_KEY.
function signFezPayload(payload: { orderNumber?: string; status?: string }, timestamp: string): string {
  return createHmac('sha256', process.env.FEZ_SECRET_KEY!)
    .update(`${payload.orderNumber ?? ''}${payload.status ?? ''}${timestamp}`)
    .digest('hex')
}

function fezHeaders(payload: { orderNumber?: string; status?: string }, timestamp = Date.now().toString()) {
  return {
    'content-type': 'application/json',
    'x-timestamp': timestamp,
    'x-signature': signFezPayload(payload, timestamp),
  }
}

describe('FEZ webhook route', () => {
  it('rejects a request with no signature/timestamp headers at all', async () => {
    const app = await buildApp()
    const payload = { orderNumber: 'fez_order_123', status: 'In Transit' }

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a request with a wrong signature', async () => {
    const app = await buildApp()
    const payload = { orderNumber: 'fez_order_123', status: 'In Transit' }
    const timestamp = Date.now().toString()

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': 'not-the-real-signature' },
      payload: JSON.stringify(payload),
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a request with a stale timestamp — replay protection', async () => {
    const app = await buildApp()
    const payload = { orderNumber: 'fez_order_123', status: 'In Transit' }
    const staleTimestamp = (Date.now() - 10 * 60 * 1000).toString() // 10 min old

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: { 'content-type': 'application/json', 'x-timestamp': staleTimestamp, 'x-signature': signFezPayload(payload, staleTimestamp) },
      payload: JSON.stringify(payload),
    })
    expect(res.statusCode).toBe(401)
  })

  it('updates the matching fulfilment by (provider, providerOrderId) and maps the raw status to the Mesa enum', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const fulfilment = await seedBookedFulfilment(db)
    const payload = { orderNumber: 'fez_order_123', status: 'in_transit' }

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/fez',
      headers: fezHeaders(payload),
      payload: JSON.stringify(payload),
    })

    expect(res.statusCode).toBe(200)
    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('IN_TRANSIT')
    expect(refreshed?.providerStatus).toBe('in_transit')
  })

  it('maps FEZ\'s confirmed "Delivered" status (from their own webhook docs)', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const fulfilment = await seedBookedFulfilment(db)
    const payload = { orderNumber: 'fez_order_123', status: 'Delivered' }

    await app.inject({ method: 'POST', url: '/webhooks/fez', headers: fezHeaders(payload), payload: JSON.stringify(payload) })

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('DELIVERED')
  })

  it('replaying the identical event is a no-op (idempotent)', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const fulfilment = await seedBookedFulfilment(db)
    const payload = { orderNumber: 'fez_order_123', status: 'delivered' }
    const send = () => app.inject({ method: 'POST', url: '/webhooks/fez', headers: fezHeaders(payload), payload: JSON.stringify(payload) })

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
    const payload = { orderNumber: 'fez_order_123', status: 'rider_en_route' }

    await app.inject({ method: 'POST', url: '/webhooks/fez', headers: fezHeaders(payload), payload: JSON.stringify(payload) })

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('BOOKED')
    expect(refreshed?.providerStatus).toBe('rider_en_route')
  })

  it('ignores an event with no orderNumber rather than erroring', async () => {
    const app = await buildApp()
    const payload = { status: 'delivered' }

    const res = await app.inject({ method: 'POST', url: '/webhooks/fez', headers: fezHeaders(payload), payload: JSON.stringify(payload) })

    expect(res.statusCode).toBe(200)
  })
})
