import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { merchants, products } from '@mesa/db'
import { eq } from 'drizzle-orm'

export async function merchantRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // Get merchant profile
  app.get<{ Params: { id: string } }>('/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, req.params.id),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })
    return { merchant }
  })

  // List products for a merchant
  app.get<{ Params: { id: string } }>('/:id/products', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req) => {
    const result = await db.query.products.findMany({
      where: eq(products.merchantId, req.params.id),
    })
    return { products: result }
  })

  // Add a product
  app.post<{
    Params: { id: string }
    Body: { name: string; price: number; stockQuantity?: number; unit?: string }
  }>('/:id/products', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { name, price, stockQuantity = 0, unit = 'unit' } = req.body

    const [product] = await db
      .insert(products)
      .values({
        merchantId: req.params.id,
        name,
        price: price.toString(),
        stockQuantity,
        unit,
      })
      .returning()

    return reply.status(201).send({ product })
  })

  // Store Mono account ID after onboarding
  app.post<{
    Params: { id: string }
    Body: { monoAccountId: string }
  }>('/:id/mono', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, req.params.id),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    const config = {
      ...(merchant.config ?? {}),
      monoAccountId: req.body.monoAccountId,
    }

    await db.update(merchants).set({ config }).where(eq(merchants.id, req.params.id))
    return reply.status(200).send({ ok: true })
  })
}
