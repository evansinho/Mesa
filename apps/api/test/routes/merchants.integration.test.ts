import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { billingEvents, merchants, products } from '@mesa/db'
import { merchantRoutes } from '../../src/routes/merchants'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createProduct } from '@test-helpers/factories'
import { createSessionHeaders, internalAuthHeaders } from '@test-helpers/auth'

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
  await app.register(merchantRoutes, { prefix: '/merchants' })
  apps.push(app)
  return app
}

describe('Merchant route tenant scoping', () => {
  it('allows a browser session to read its own merchant profile', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    const res = await app.inject({
      method: 'GET',
      url: `/merchants/${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { merchant: { id: string } }).merchant.id).toBe(merchant.id)
  })

  it('rejects a browser session reading another merchant profile', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)

    const res = await app.inject({
      method: 'GET',
      url: `/merchants/${merchantB.id}`,
      headers: await createSessionHeaders(db, merchantA.id),
    })

    expect(res.statusCode).toBe(403)
  })

  it('rejects product creation under another merchant id', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)

    const res = await app.inject({
      method: 'POST',
      url: `/merchants/${merchantB.id}/products`,
      headers: await createSessionHeaders(db, merchantA.id),
      payload: { name: 'Rice', price: 1000 },
    })

    expect(res.statusCode).toBe(403)
    const rows = await db.query.products.findMany({
      where: eq(products.merchantId, merchantB.id),
    })
    expect(rows).toHaveLength(0)
  })

  it('creates and returns product aliases and last price', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const headers = await createSessionHeaders(db, merchant.id)

    const createRes = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/products`,
      headers,
      payload: { name: 'Rice', price: 5000, lastPrice: 4500, aliases: ['bag rice', 'ofada'] },
    })
    expect(createRes.statusCode).toBe(201)

    const listRes = await app.inject({
      method: 'GET',
      url: `/merchants/${merchant.id}/products`,
      headers,
    })
    expect(listRes.statusCode).toBe(200)
    const body = listRes.json() as { products: Array<{ lastPrice: string | null; aliases: string[] }> }
    expect(body.products[0].lastPrice).toBe('4500.00')
    expect(body.products[0].aliases).toEqual(['bag rice', 'ofada'])
  })

  it('rejects product last price above list price', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const headers = await createSessionHeaders(db, merchant.id)

    const res = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/products`,
      headers,
      payload: { name: 'Rice', price: 5000, lastPrice: 5500 },
    })

    expect(res.statusCode).toBe(400)
  })

  it('updates product aliases and last price with validation', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const headers = await createSessionHeaders(db, merchant.id)
    const product = await createProduct(db, merchant.id, { name: 'Rice', price: '5000' })

    const badRes = await app.inject({
      method: 'PATCH',
      url: `/merchants/${merchant.id}/products/${product.id}`,
      headers,
      payload: { lastPrice: 6000 },
    })
    expect(badRes.statusCode).toBe(400)

    const res = await app.inject({
      method: 'PATCH',
      url: `/merchants/${merchant.id}/products/${product.id}`,
      headers,
      payload: { lastPrice: 4500, aliases: ['bag rice'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { product: { lastPrice: string; aliases: string[] } }
    expect(body.product.lastPrice).toBe('4500.00')
    expect(body.product.aliases).toEqual(['bag rice'])
  })

  it('does not update another merchant product even when the product id is known', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)
    const product = await createProduct(db, merchantB.id, { name: 'Original' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/merchants/${merchantA.id}/products/${product.id}`,
      headers: await createSessionHeaders(db, merchantA.id),
      payload: { name: 'Changed' },
    })

    expect(res.statusCode).toBe(404)
    const refreshed = await db.query.products.findFirst({
      where: eq(products.id, product.id),
    })
    expect(refreshed?.name).toBe('Original')
  })

  it('does not delete another merchant product even when the product id is known', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)
    const product = await createProduct(db, merchantB.id)

    const res = await app.inject({
      method: 'DELETE',
      url: `/merchants/${merchantA.id}/products/${product.id}`,
      headers: await createSessionHeaders(db, merchantA.id),
    })

    expect(res.statusCode).toBe(404)
    const refreshed = await db.query.products.findFirst({
      where: eq(products.id, product.id),
    })
    expect(refreshed).not.toBeNull()
  })

  it('rejects deleting another merchant account', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)

    const res = await app.inject({
      method: 'DELETE',
      url: `/merchants/${merchantB.id}`,
      headers: await createSessionHeaders(db, merchantA.id),
    })

    expect(res.statusCode).toBe(403)
    const refreshed = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantB.id),
    })
    expect(refreshed).not.toBeNull()
  })

  it('allows internal callers to access explicit merchant routes', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    const res = await app.inject({
      method: 'GET',
      url: `/merchants/${merchant.id}`,
      headers: internalAuthHeaders(),
    })

    expect(res.statusCode).toBe(200)
  })

  it('merges config without overwriting existing merchant config', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, {
      config: {
        paymentInstructions: 'Pay GTB',
        tone: 'friendly',
      },
    })
    const headers = await createSessionHeaders(db, merchant.id)

    const res = await app.inject({
      method: 'PATCH',
      url: `/merchants/${merchant.id}`,
      headers,
      payload: { config: { tone: 'direct', receiptNote: 'Send receipt here.' } },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { merchant: { config: Record<string, unknown> } }
    expect(body.merchant.config.paymentInstructions).toBe('Pay GTB')
    expect(body.merchant.config.tone).toBe('direct')
    expect(body.merchant.config.receiptNote).toBe('Send receipt here.')
  })

  it('starts a trial when a merchant signs up', async () => {
    const app = await buildApp()
    const db = getTestDb()

    const res = await app.inject({
      method: 'POST',
      url: '/merchants',
      payload: { name: 'Ada Store', phone: '08012345678' },
    })

    expect(res.statusCode).toBe(201)
    const merchant = (res.json() as { merchant: { id: string; subscriptionStatus: string; trialEndsAt: string; config: Record<string, unknown> } }).merchant
    expect(merchant.subscriptionStatus).toBe('trialing')
    expect(new Date(merchant.trialEndsAt).getTime()).toBeGreaterThan(Date.now())
    expect(merchant.config).toEqual({})

    const event = await db.query.billingEvents.findFirst({
      where: eq(billingEvents.merchantId, merchant.id),
    })
    expect(event?.type).toBe('trial_started')
  })

  it('rejects duplicate signup and tells the merchant to sign in', async () => {
    const app = await buildApp()
    const db = getTestDb()
    await createMerchant(db, { phone: '+2348012345678' })

    const res = await app.inject({
      method: 'POST',
      url: '/merchants',
      payload: { name: 'Ada Store', phone: '08012345678' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual(expect.objectContaining({
      code: 'MERCHANT_ALREADY_EXISTS',
    }))
  })

  it('allows a merchant to save billing email and view subscription state', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const headers = await createSessionHeaders(db, merchant.id)

    const updateRes = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/billing-email`,
      headers,
      payload: { email: 'Owner@Example.COM ' },
    })
    expect(updateRes.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET',
      url: `/merchants/${merchant.id}/subscription`,
      headers,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      status: string
      daysRemaining: number
      email: string
      needsEmail: boolean
    }
    expect(body.status).toBe('trialing')
    expect(body.daysRemaining).toBeGreaterThan(0)
    expect(body.email).toBe('owner@example.com')
    expect(body.needsEmail).toBe(false)
  })

  it('creates checkout only from the explicit checkout endpoint', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const headers = await createSessionHeaders(db, merchant.id)

    const needsEmailRes = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/subscription/checkout`,
      headers,
    })
    expect(needsEmailRes.statusCode).toBe(400)

    await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/billing-email`,
      headers,
      payload: { email: 'owner@example.com' },
    })

    const missingConfigRes = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/subscription/checkout`,
      headers,
    })
    expect(missingConfigRes.statusCode).toBe(503)
  })

  it('rejects billing email updates for another merchant', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)

    const res = await app.inject({
      method: 'POST',
      url: `/merchants/${merchantB.id}/billing-email`,
      headers: await createSessionHeaders(db, merchantA.id),
      payload: { email: 'owner@example.com' },
    })

    expect(res.statusCode).toBe(403)
  })
})
