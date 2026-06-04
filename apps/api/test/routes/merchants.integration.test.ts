import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { merchants, products } from '@mesa/db'
import { merchantRoutes } from '../../src/routes/merchants'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createProduct } from '@test-helpers/factories'
import { createSessionHeaders, internalAuthHeaders } from '@test-helpers/auth'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(merchantRoutes, { prefix: '/merchants' })
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
})
