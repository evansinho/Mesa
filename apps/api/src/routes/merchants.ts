import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { merchants, products, merchantChannels } from '@mesa/db'
import { eq } from 'drizzle-orm'

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  const national = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${national}`
}

export async function merchantRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // Create merchant (signup)
  app.post<{
    Body: { name?: string; phone: string }
  }>('/', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { name, phone } = req.body
    const normalizedPhone = normalizePhone(phone)
    const merchantName = name?.trim() || normalizedPhone

    const existing = await db.query.merchants.findFirst({
      where: eq(merchants.phone, normalizedPhone),
    })
    if (existing) {
      return reply.status(200).send({ merchant: existing, existing: true })
    }

    const [merchant] = await db
      .insert(merchants)
      .values({
        name: merchantName,
        phone: normalizedPhone,
      })
      .returning()

    return reply.status(201).send({ merchant })
  })

  // Get merchant profile
  app.get<{ Params: { id: string } }>('/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, req.params.id),
      with: { channels: true },
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

  // Update product (stock, name, price, unit, lowStockThreshold)
  app.patch<{
    Params: { id: string; productId: string }
    Body: { stockQuantity?: number; name?: string; price?: number; unit?: string; lowStockThreshold?: number }
  }>('/:id/products/:productId', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { stockQuantity, name, price, unit, lowStockThreshold } = req.body

    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (stockQuantity !== undefined) {
      if (Number.isNaN(stockQuantity)) return reply.status(400).send({ error: 'Invalid stockQuantity' })
      patch.stockQuantity = stockQuantity
    }
    if (name !== undefined) patch.name = name.trim()
    if (price !== undefined) patch.price = price.toString()
    if (unit !== undefined) patch.unit = unit.trim()
    if (lowStockThreshold !== undefined) patch.lowStockThreshold = lowStockThreshold

    const [updated] = await db
      .update(products)
      .set(patch)
      .where(eq(products.id, req.params.productId))
      .returning()

    if (!updated) return reply.status(404).send({ error: 'Product not found' })
    return reply.status(200).send({ product: updated })
  })

  // Delete a product
  app.delete<{ Params: { id: string; productId: string } }>(
    '/:id/products/:productId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const deleted = await db
        .delete(products)
        .where(eq(products.id, req.params.productId))
        .returning({ id: products.id })

      if (!deleted.length) return reply.status(404).send({ error: 'Product not found' })
      return reply.status(200).send({ ok: true })
    }
  )

  // Update merchant profile and config
  app.patch<{
    Params: { id: string }
    Body: {
      name?: string
      businessType?: string
      config?: {
        paused?: boolean
        paymentInstructions?: string
      }
    }
  }>('/:id', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, req.params.id),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    const updatedConfig = req.body.config
      ? { ...(merchant.config ?? {}), ...req.body.config }
      : merchant.config

    const [updated] = await db.update(merchants).set({
      name: req.body.name ?? merchant.name,
      businessType: req.body.businessType ?? merchant.businessType,
      config: updatedConfig,
      updatedAt: new Date(),
    }).where(eq(merchants.id, req.params.id)).returning()

    return reply.status(200).send({ merchant: updated })
  })

  // Delete merchant account
  app.delete<{ Params: { id: string } }>('/:id', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, req.params.id),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    await db.delete(merchants).where(eq(merchants.id, req.params.id))
    return reply.status(200).send({ ok: true })
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

  // Store WhatsApp Embedded Signup results
  app.post<{
    Params: { id: string }
    Body: { phoneNumberId: string }
  }>('/:id/whatsapp', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, req.params.id),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    await db.insert(merchantChannels).values({
      merchantId: req.params.id,
      channel: 'whatsapp',
      channelAccountId: req.body.phoneNumberId,
      status: 'connected',
    }).onConflictDoNothing()

    return reply.status(200).send({ ok: true })
  })
}
