import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { billingEvents, merchants, products, merchantChannels, subscriptions, statusPosts, trackingLinks, trackingLinkClicks } from '@mesa/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { authorizeMerchant } from '../auth-context'
import { cancelSubscription, generatePaymentLink } from '../lib/paystack'
import { sendTemplate, uploadMedia, sendImage, sendText } from '@mesa/whatsapp'
import { uploadProductImage } from '../lib/r2'
import { exchangeMonoCode } from '../lib/mono'
import { generateSlug, isTrackingLinkPlatform, trackingLinkUrl } from './tracking-links'

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  const national = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${national}`
}

function normalizeAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(alias => typeof alias === 'string' ? alias.trim() : '')
    .filter(Boolean)
}

function invalidLastPrice(price: number | undefined, lastPrice: number | null | undefined): boolean {
  if (lastPrice == null) return false
  if (!Number.isFinite(lastPrice) || lastPrice < 0) return true
  return price !== undefined && Number.isFinite(price) && lastPrice > price
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
      return reply.status(409).send({
        error: 'An account already exists for this phone number. Please sign in instead.',
        code: 'MERCHANT_ALREADY_EXISTS',
      })
    }

    const [merchant] = await db
      .insert(merchants)
      .values({
        name: merchantName,
        phone: normalizedPhone,
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        subscriptionStatus: 'trialing',
        config: {},
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
    Body: {
      name: string
      price: number
      lastPrice?: number | null
      aliases?: string[]
      stockQuantity?: number
      lowStockThreshold?: number
      unit?: string
    }
  }>('/:id/products', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!
    const { name, price, lastPrice, aliases, stockQuantity = 0, lowStockThreshold = 5, unit = 'unit' } = req.body
    if (!name?.trim()) return reply.status(400).send({ error: 'Name is required' })
    if (!Number.isFinite(price) || price <= 0) return reply.status(400).send({ error: 'Invalid price' })
    if (invalidLastPrice(price, lastPrice)) return reply.status(400).send({ error: 'lastPrice must be less than or equal to price' })

    const [product] = await db
      .insert(products)
      .values({
        merchantId,
        name: name.trim(),
        price: price.toString(),
        lastPrice: lastPrice == null ? null : lastPrice.toString(),
        aliases: normalizeAliases(aliases),
        stockQuantity,
        lowStockThreshold,
        unit,
      })
      .returning()

    return reply.status(201).send({ product })
  })

  // Update product (stock, name, price, unit, lowStockThreshold)
  app.patch<{
    Params: { id: string; productId: string }
    Body: {
      stockQuantity?: number
      name?: string
      price?: number
      lastPrice?: number | null
      aliases?: string[]
      unit?: string
      lowStockThreshold?: number
    }
  }>('/:id/products/:productId', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!
    const { stockQuantity, name, price, lastPrice, aliases, unit, lowStockThreshold } = req.body

    const existing = await db.query.products.findFirst({
      where: and(eq(products.id, req.params.productId), eq(products.merchantId, merchantId)),
    })
    if (!existing) return reply.status(404).send({ error: 'Product not found' })

    const effectivePrice = price ?? parseFloat(existing.price)
    if (price !== undefined && (!Number.isFinite(price) || price <= 0)) {
      return reply.status(400).send({ error: 'Invalid price' })
    }
    if (lastPrice !== undefined && invalidLastPrice(effectivePrice, lastPrice)) {
      return reply.status(400).send({ error: 'lastPrice must be less than or equal to price' })
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (stockQuantity !== undefined) {
      if (Number.isNaN(stockQuantity)) return reply.status(400).send({ error: 'Invalid stockQuantity' })
      patch.stockQuantity = stockQuantity
    }
    if (name !== undefined) patch.name = name.trim()
    if (price !== undefined) patch.price = price.toString()
    if (lastPrice !== undefined) patch.lastPrice = lastPrice == null ? null : lastPrice.toString()
    if (aliases !== undefined) patch.aliases = normalizeAliases(aliases)
    if (unit !== undefined) patch.unit = unit.trim()
    if (lowStockThreshold !== undefined) patch.lowStockThreshold = lowStockThreshold

    const [updated] = await db
      .update(products)
      .set(patch)
      .where(and(eq(products.id, req.params.productId), eq(products.merchantId, merchantId)))
      .returning()

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
      address?: string | null
      config?: {
        paused?: boolean
        paymentInstructions?: string
        bankAccount?: {
          bankName: string
          accountNumber: string
          accountName: string
        }
        [key: string]: unknown
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

    const existingConfig = (merchant.config ?? {}) as Record<string, unknown>
    const incomingConfig = (req.body.config ?? undefined) as Record<string, unknown> | undefined
    const updatedConfig = incomingConfig
      ? {
          ...existingConfig,
          ...incomingConfig,
        }
      : merchant.config

    const [updated] = await db.update(merchants).set({
      name: req.body.name ?? merchant.name,
      businessType: req.body.businessType ?? merchant.businessType,
      address: req.body.address !== undefined ? (req.body.address?.trim() || null) : merchant.address,
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

  // Link a Mono bank account after the Connect widget hands back a code —
  // exchange it server-side (the secret key never reaches the browser) and
  // store the resulting permanent account id.
  app.post<{
    Params: { id: string }
    Body: { code: string }
  }>('/:id/mono', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    if (!req.body?.code) return reply.status(400).send({ error: 'code is required' })

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    const monoAccountId = await exchangeMonoCode(req.body.code)
    if (!monoAccountId) {
      return reply.status(502).send({ error: 'Could not verify the bank connection with Mono. Please try again.' })
    }

    const updatedConfig = {
      ...(merchant.config ?? {}),
      monoAccountId,
    }

    await db.update(merchants).set({ config: updatedConfig }).where(eq(merchants.id, merchantId))
    return reply.status(200).send({ ok: true })
  })

  // Unlink the Mono bank account. Only clears the stored account id — the
  // link on Mono's own side is untouched, so reconnecting later (a fresh
  // widget code) works the same as connecting for the first time.
  app.delete<{ Params: { id: string } }>('/:id/mono', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    const updatedConfig = { ...(merchant.config ?? {}) }
    delete updatedConfig.monoAccountId

    await db.update(merchants).set({ config: updatedConfig }).where(eq(merchants.id, merchantId))
    return reply.status(200).send({ ok: true })
  })

  // ─── Tracking links (order-source analytics) ────────────────────────────

  app.get<{ Params: { id: string } }>('/:id/tracking-links', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const links = await db.query.trackingLinks.findMany({
      where: eq(trackingLinks.merchantId, merchantId),
      orderBy: [desc(trackingLinks.createdAt)],
    })

    const clickCounts = await db
      .select({ trackingLinkId: trackingLinkClicks.trackingLinkId, count: sql<number>`COUNT(*)` })
      .from(trackingLinkClicks)
      .where(eq(trackingLinkClicks.merchantId, merchantId))
      .groupBy(trackingLinkClicks.trackingLinkId)
    const countByLink = new Map(clickCounts.map(c => [c.trackingLinkId, Number(c.count)]))

    return {
      links: links.map(link => ({
        id: link.id,
        platform: link.platform,
        slug: link.slug,
        url: trackingLinkUrl(link.slug),
        clickCount: countByLink.get(link.id) ?? 0,
        createdAt: link.createdAt,
      })),
    }
  })

  app.post<{ Params: { id: string }; Body: { platform: string } }>('/:id/tracking-links', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const platform = req.body?.platform
    if (!platform || !isTrackingLinkPlatform(platform)) {
      return reply.status(400).send({ error: 'platform must be one of tiktok, instagram, facebook, website' })
    }

    // Collision odds against an 8-char, 32-symbol alphabet are astronomically
    // low — this retry loop is defense-in-depth, not an expected path.
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = generateSlug()
      const existing = await db.query.trackingLinks.findFirst({ where: eq(trackingLinks.slug, slug) })
      if (existing) continue

      const [link] = await db.insert(trackingLinks).values({ merchantId, platform, slug }).returning()
      return reply.status(201).send({
        id: link.id,
        platform: link.platform,
        slug: link.slug,
        url: trackingLinkUrl(link.slug),
      })
    }
    return reply.status(500).send({ error: 'Could not generate a unique link — please try again' })
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

  // Upload product image
  app.post<{ Params: { id: string; productId: string } }>('/:id/products/:productId/image', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('image/')) {
      return reply.status(400).send({ error: 'Content-Type must be image/*' })
    }

    const buffer = await req.body as Buffer
    if (!buffer || buffer.length === 0) return reply.status(400).send({ error: 'Empty body' })
    if (buffer.length > 5 * 1024 * 1024) return reply.status(400).send({ error: 'Image must be under 5MB' })

    const existing = await db.query.products.findFirst({
      where: and(eq(products.id, req.params.productId), eq(products.merchantId, merchantId)),
      columns: { id: true },
    })
    if (!existing) return reply.status(404).send({ error: 'Product not found' })

    const imageUrl = await uploadProductImage(buffer, contentType)
    const [product] = await db.update(products)
      .set({ imageUrl, updatedAt: new Date() })
      .where(and(eq(products.id, req.params.productId), eq(products.merchantId, merchantId)))
      .returning()

    return reply.status(200).send({ product })
  })

  // Post product to WhatsApp Status
  app.post<{ Params: { id: string; productId: string }; Body: { caption?: string } }>('/:id/products/:productId/post-to-status', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, req.params.id)
    if (!auth.ok) return
    const merchantId = auth.merchantId!

    const [merchant, product] = await Promise.all([
      db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true, name: true, config: true },
      }),
      db.query.products.findFirst({
        where: and(eq(products.id, req.params.productId), eq(products.merchantId, merchantId)),
      }),
    ])

    if (!merchant?.phone) return reply.status(404).send({ error: 'Merchant not found' })
    if (!product) return reply.status(404).send({ error: 'Product not found' })

    const price = `₦${Number(product.price).toLocaleString()}`
    const floorLine = product.lastPrice ? `\n~~₦${Number(product.lastPrice).toLocaleString()}~~` : ''
    const descLine = product.description ? `\n${product.description}` : ''
    const caption = req.body?.caption?.trim() || [
      `🛍️ *${product.name}*`,
      `💰 ${price}${floorLine}`,
      descLine,
      '',
      'DM to order 📲',
    ].filter(l => l !== undefined).join('\n').trim()

    let statusPost: typeof statusPosts.$inferSelect | undefined

    if (product.imageUrl) {
      try {
        const imgRes = await fetch(product.imageUrl)
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer())
          const mimeType = imgRes.headers.get('content-type') ?? 'image/jpeg'
          const mediaId = await uploadMedia(buffer, mimeType)
          const sent = await sendImage(merchant.phone, mediaId, caption)
          ;[statusPost] = await db.insert(statusPosts).values({
            merchantId,
            productId: product.id,
            whatsappMessageId: sent.messages?.[0]?.id,
            caption,
            imageUrl: product.imageUrl,
          }).returning()
          return reply.status(200).send({ ok: true, statusPost })
        }
      } catch {
        // fall through to text fallback
      }
    }

    const sent = await sendText(merchant.phone, caption)
    ;[statusPost] = await db.insert(statusPosts).values({
      merchantId,
      productId: product.id,
      whatsappMessageId: sent.messages?.[0]?.id,
      caption,
    }).returning()

    return reply.status(200).send({ ok: true, statusPost })
  })
}
