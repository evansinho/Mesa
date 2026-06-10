import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { billingEvents, merchants, products, merchantChannels, subscriptions } from '@mesa/db'
import { and, desc, eq } from 'drizzle-orm'
import { authorizeMerchant } from '../auth-context'
import { cancelSubscription, generatePaymentLink } from '../lib/paystack'
import { sendTemplate } from '@mesa/whatsapp'

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
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        subscriptionStatus: 'trialing',
      })
      .returning()

    await db.insert(billingEvents).values({
      merchantId: merchant.id,
      type: 'trial_started',
      metadata: { source: 'signup' },
    })

    return reply.status(201).send({ merchant })
  })

  // Get merchant profile
  app.get<{ Params: { id: string } }>('/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      with: { channels: true },
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })
    return { merchant }
  })

  // List products for a merchant
  app.get<{ Params: { id: string } }>('/:id/products', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const result = await db.query.products.findMany({
      where: eq(products.merchantId, merchantId),
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
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!
    const { name, price, stockQuantity = 0, unit = 'unit' } = req.body

    const [product] = await db
      .insert(products)
      .values({
        merchantId,
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
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!
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
      .where(and(eq(products.id, req.params.productId), eq(products.merchantId, merchantId)))
      .returning()

    if (!updated) return reply.status(404).send({ error: 'Product not found' })
    return reply.status(200).send({ product: updated })
  })

  // Delete a product
  app.delete<{ Params: { id: string; productId: string } }>(
    '/:id/products/:productId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const auth = authorizeMerchant(req, reply, req.params.id)
      if (!auth.ok) return
      const merchantId = auth.merchantId!

      const deleted = await db
        .delete(products)
        .where(and(eq(products.id, req.params.productId), eq(products.merchantId, merchantId)))
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
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
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
    }).where(eq(merchants.id, merchantId)).returning()

    return reply.status(200).send({ merchant: updated })
  })

  app.get<{ Params: { id: string } }>('/:id/subscription', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    const subscription = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.merchantId, merchantId),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    })
    const events = await db.query.billingEvents.findMany({
      where: eq(billingEvents.merchantId, merchantId),
      orderBy: [desc(billingEvents.createdAt)],
      limit: 25,
    })

    const trialEndsAt = merchant.trialEndsAt ?? new Date()
    const daysRemaining = Math.max(
      0,
      Math.ceil((trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
    )
    return {
      status: merchant.subscriptionStatus,
      trialEndsAt,
      daysRemaining,
      plan: merchant.subscriptionTier,
      currentPeriodEnd: subscription?.currentPeriodEnd,
      email: merchant.email,
      needsEmail: !merchant.email,
      events,
    }
  })

  app.post<{ Params: { id: string } }>('/:id/subscription/checkout', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { subscriptionStatus: true },
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })
    if (merchant.subscriptionStatus === 'active') {
      return reply.status(400).send({ error: 'Subscription already active' })
    }

    const linkState = await generatePaymentLink(db, merchantId)
    if (linkState.needsEmail) return reply.status(400).send({ error: 'Billing email required' })
    if (linkState.error) return reply.status(503).send({ error: linkState.error })
    return { paymentLink: linkState.paymentLink }
  })

  app.post<{
    Params: { id: string }
    Body: { email: string }
  }>('/:id/billing-email', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!
    const email = req.body.email?.trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.status(400).send({ error: 'Valid email required' })
    }

    await db.update(merchants)
      .set({ email, updatedAt: new Date() })
      .where(eq(merchants.id, merchantId))
    return { ok: true, email }
  })

  app.post<{ Params: { id: string } }>('/:id/subscription/cancel', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const subscription = await db.query.subscriptions.findFirst({
      where: and(eq(subscriptions.merchantId, merchantId), eq(subscriptions.status, 'active')),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    })
    if (!subscription?.paystackSubscriptionCode) {
      return reply.status(404).send({ error: 'Active subscription not found' })
    }

    if (!subscription.paystackEmailToken) {
      return reply.status(400).send({ error: 'Subscription cancellation token unavailable' })
    }

    await cancelSubscription(subscription.paystackSubscriptionCode, subscription.paystackEmailToken)
    await db.update(merchants)
      .set({ subscriptionStatus: 'cancelled', updatedAt: new Date() })
      .where(eq(merchants.id, merchantId))
    await db.update(subscriptions)
      .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id))
    await db.insert(billingEvents).values({
      merchantId,
      type: 'subscription_cancelled',
      metadata: { source: 'dashboard' },
    })

    return { ok: true }
  })

  // Delete merchant account
  app.delete<{ Params: { id: string } }>('/:id', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    await db.delete(merchants).where(eq(merchants.id, merchantId))
    return reply.status(200).send({ ok: true })
  })

  // Store Mono account ID after onboarding
  app.post<{
    Params: { id: string }
    Body: { monoAccountId: string }
  }>('/:id/mono', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    const config = {
      ...(merchant.config ?? {}),
      monoAccountId: req.body.monoAccountId,
    }

    await db.update(merchants).set({ config }).where(eq(merchants.id, merchantId))
    return reply.status(200).send({ ok: true })
  })

  // Mark onboarding complete — merchant has finished the dashboard setup wizard
  app.post<{ Params: { id: string } }>('/:id/onboarding/complete', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    if (!merchant.name || merchant.name.trim() === '') {
      return reply.status(422).send({ error: 'Business name is required to complete setup' })
    }

    await db.update(merchants).set({
      config: {
        ...(merchant.config ?? {}),
        onboarding: { status: 'complete', step: 'DONE' },
      },
      updatedAt: new Date(),
    }).where(eq(merchants.id, merchantId))

    let templateError: string | undefined
    if (merchant.phone) {
      try {
        await sendTemplate(merchant.phone, 'mesa_setup_complete', [merchant.name], {
          languageCode: 'en',
          buttons: [{ type: 'url', index: 0, urlSuffix: 'dashboard' }],
        })
      } catch (err) {
        templateError = err instanceof Error ? err.message : String(err)
        app.log.warn({ err, merchantId }, 'Failed to send setup complete template')
      }
    }

    return reply.status(200).send({ ok: true, templateError })
  })

  // Temporary: test sendTemplate and surface raw Meta error
  app.post<{ Params: { id: string } }>('/:id/test-template', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!
    const merchant = await db.query.merchants.findFirst({ where: eq(merchants.id, merchantId) })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })
    try {
      const result = await sendTemplate(merchant.phone!, 'mesa_setup_complete', [merchant.name ?? 'Test'], {
        languageCode: 'en',
        buttons: [{ type: 'url', index: 0, urlSuffix: 'dashboard' }],
      })
      return reply.send({ ok: true, result })
    } catch (err) {
      return reply.status(200).send({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Store WhatsApp Embedded Signup results
  app.post<{
    Params: { id: string }
    Body: { phoneNumberId: string }
  }>('/:id/whatsapp', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    await db.insert(merchantChannels).values({
      merchantId,
      channel: 'whatsapp',
      channelAccountId: req.body.phoneNumberId,
      status: 'connected',
    }).onConflictDoNothing()

    return reply.status(200).send({ ok: true })
  })
}
