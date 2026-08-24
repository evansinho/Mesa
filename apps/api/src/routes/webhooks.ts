import type { FastifyInstance } from 'fastify'
import Redis from 'ioredis'
import { and, eq } from 'drizzle-orm'
import { config } from '@mesa/config'
import type { Db } from '@mesa/db'
import { billingEvents, fulfilments, fulfilmentStatusEnum, merchants, subscriptions } from '@mesa/db'
import { sendText } from '@mesa/whatsapp'
import { planAmountKobo, paystackPlanCode, verifyPaystackSignature } from '../lib/paystack'

type MonoWebhookPayload = {
  event: string
  event_id: string
  timestamp: string
  data: Record<string, unknown>
}

// Field names (event, data.orderNumber, data.orderStatus) match the same
// documented-but-unverified shape assumed in apps/worker/src/delivery/fez.ts
// — confirm against a real sandbox webhook delivery before relying on this
// in production. Kept off by default via DELIVERY_INTEGRATIONS_ENABLED.
type FezWebhookPayload = {
  event: string
  data: {
    orderNumber?: string
    orderStatus?: string
    trackingUrl?: string
  }
}

// Mirrors the raw-status mapping in apps/worker/src/delivery/fez.ts's
// mapStatus — duplicated rather than imported, since apps/api and
// apps/worker are independently deployable services and don't share code
// across the app boundary (only packages/* is shared). Only forward,
// terminal-leaning transitions are applied here; anything unrecognized
// still updates providerStatus (for visibility/debugging) without moving
// the coarse Mesa status enum, so an unmapped value never gets guessed into
// a wrong lifecycle state.
function mapFezStatusToFulfilmentStatus(raw: string | undefined): (typeof fulfilmentStatusEnum.enumValues)[number] | undefined {
  switch ((raw ?? '').toLowerCase()) {
    case 'delivered':
      return 'DELIVERED'
    case 'cancelled':
    case 'canceled':
    case 'failed':
      return 'CANCELLED'
    case 'in_transit':
    case 'in-transit':
    case 'dispatched':
      return 'IN_TRANSIT'
    default:
      return undefined
  }
}

type PaystackPayload = {
  event: string
  data: {
    id?: number | string
    reference?: string
    status?: string
    amount?: number
    paid_at?: string
    created_at?: string
    customer?: { customer_code?: string; email?: string }
    metadata?: { merchantId?: string; plan?: 'starter' | 'growth' | 'business' }
    plan?: { plan_code?: string }
    subscription_code?: string
    subscription?: { subscription_code?: string }
    authorization?: { authorization_code?: string }
    email_token?: string
  }
}

function eventKey(payload: PaystackPayload): string {
  const data = payload.data
  const stable = data.id ?? data.reference ?? data.subscription_code ?? data.subscription?.subscription_code ?? 'unknown'
  return `paystack:${payload.event}:${stable}`
}

function subscriptionCode(data: PaystackPayload['data']): string | undefined {
  return data.subscription_code ?? data.subscription?.subscription_code
}

function eventDate(value: string | undefined): Date {
  const date = value ? new Date(value) : new Date()
  return Number.isNaN(date.getTime()) ? new Date() : date
}

export async function webhookRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db
  const redis = new Redis(config.REDIS_URL)
  redis.on('error', (error) => app.log.error({ error }, 'Paystack webhook Redis error'))
  app.addHook('onClose', async () => {
    redis.disconnect()
  })

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const rawBody = typeof body === 'string' ? body : body.toString('utf8')
    ;(req as unknown as { rawBody: string }).rawBody = rawBody

    try {
      done(null, JSON.parse(rawBody))
    } catch (error) {
      done(error as Error, undefined)
    }
  })

  app.post<{ Body: PaystackPayload }>('/paystack', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const rawBody = (req as unknown as { rawBody?: string }).rawBody
    const signature = req.headers['x-paystack-signature']
    if (!rawBody || !verifyPaystackSignature(rawBody, typeof signature === 'string' ? signature : undefined)) {
      return reply.status(400).send({ error: 'Invalid signature' })
    }

    const payload = req.body
    const key = eventKey(payload)
    const merchantId = payload.data.metadata?.merchantId
    if (!merchantId) return reply.status(200).send({ ok: true })

    const existing = await db.query.billingEvents.findFirst({
      where: eq(billingEvents.eventKey, key),
    })
    if (existing) return reply.status(200).send({ ok: true })

    if (payload.event === 'charge.success') {
      const plan = payload.data.metadata?.plan ?? 'starter'
      const now = eventDate(payload.data.paid_at ?? payload.data.created_at)
      const periodEnd = new Date(now)
      periodEnd.setMonth(periodEnd.getMonth() + 1)
      const subCode = subscriptionCode(payload.data)
      const planCode = payload.data.plan?.plan_code ?? paystackPlanCode(plan) ?? 'unknown'

      await db.transaction(async (tx) => {
        await tx.update(merchants)
          .set({
            subscriptionStatus: 'active',
            subscriptionTier: plan,
            updatedAt: new Date(),
          })
          .where(eq(merchants.id, merchantId))

        const existingSub = subCode
          ? await tx.query.subscriptions.findFirst({
              where: eq(subscriptions.paystackSubscriptionCode, subCode),
            })
          : await tx.query.subscriptions.findFirst({
              where: and(eq(subscriptions.merchantId, merchantId), eq(subscriptions.status, 'active')),
            })

        const subValues = {
          merchantId,
          plan,
          status: 'active',
          paystackCustomerCode: payload.data.customer?.customer_code,
          paystackSubscriptionCode: subCode,
          paystackEmailToken: payload.data.email_token,
          paystackPlanCode: planCode,
          amountKobo: payload.data.amount ?? planAmountKobo(plan),
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          updatedAt: new Date(),
        }

        if (existingSub) {
          await tx.update(subscriptions).set(subValues).where(eq(subscriptions.id, existingSub.id))
        } else {
          await tx.insert(subscriptions).values(subValues)
        }

        await tx.insert(billingEvents).values({
          merchantId,
          type: 'charge_success',
          eventKey: key,
          metadata: payload as unknown as Record<string, unknown>,
        })
      })

      await redis.del(`subscription_gate:${merchantId}`)
      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true },
      })
      if (merchant?.phone) {
        await sendText(merchant.phone, 'Your Mesa subscription is active. Customer order automation is running again.')
      }
      return { ok: true }
    }

    if (payload.event === 'invoice.payment_failed') {
      await db.transaction(async (tx) => {
        await tx.update(merchants)
          .set({ subscriptionStatus: 'past_due', updatedAt: new Date() })
          .where(eq(merchants.id, merchantId))
        await tx.insert(billingEvents).values({
          merchantId,
          type: 'charge_failed',
          eventKey: key,
          metadata: payload as unknown as Record<string, unknown>,
        })
      })
      await redis.del(`subscription_gate:${merchantId}`)
      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true },
      })
      if (merchant?.phone) {
        await sendText(merchant.phone, `Your Mesa payment failed. Update billing here: ${config.DASHBOARD_URL}/billing`)
      }
      return { ok: true }
    }

    if (payload.event === 'subscription.not_renew' || payload.event === 'subscription.disable') {
      await db.transaction(async (tx) => {
        await tx.update(merchants)
          .set({ subscriptionStatus: 'cancelled', updatedAt: new Date() })
          .where(eq(merchants.id, merchantId))
        await tx.insert(billingEvents).values({
          merchantId,
          type: 'subscription_cancelled',
          eventKey: key,
          metadata: payload as unknown as Record<string, unknown>,
        })
      })
      await redis.del(`subscription_gate:${merchantId}`)
      return { ok: true }
    }

    if (payload.event === 'subscription.create') {
      await db.insert(billingEvents).values({
        merchantId,
        type: 'subscription_created',
        eventKey: key,
        metadata: payload as unknown as Record<string, unknown>,
      })
      return { ok: true }
    }

    return { ok: true }
  })

  // Mono verifies webhooks with a plain shared-secret header (not HMAC) —
  // see https://docs.mono.co/docs/webhooks. We don't yet have a confirmed
  // field-level schema for the transaction event payload from their docs,
  // so this only logs the full event for now rather than guessing field
  // names into a payment-confirmation code path. Once a real sandbox event
  // lands, wire the actual match-and-confirm logic against the observed
  // shape (see apps/worker/src/payments/mono.ts for the existing poll-based
  // confirmation this would eventually replace/complement).
  app.post<{ Body: MonoWebhookPayload }>('/mono', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const secretHeader = req.headers['mono-webhook-secret']
    if (!config.MONO_WEBHOOK_SECRET || secretHeader !== config.MONO_WEBHOOK_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    app.log.info({ event: req.body.event, eventId: req.body.event_id, data: req.body.data }, 'Mono webhook received')
    return reply.status(200).send({ ok: true })
  })

  // Signing mechanism unconfirmed — following Mono's simpler shared-secret
  // header convention (rather than Paystack's HMAC) since FEZ's own API
  // already uses static header auth, not request signing. Confirm the
  // actual header name/mechanism from FEZ's webhook-registration response
  // before enabling DELIVERY_INTEGRATIONS_ENABLED in production.
  app.post<{ Body: FezWebhookPayload }>('/fez', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const secretHeader = req.headers['x-fez-webhook-secret']
    if (!config.FEZ_WEBHOOK_SECRET || secretHeader !== config.FEZ_WEBHOOK_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const { orderNumber, orderStatus, trackingUrl } = req.body.data ?? {}
    if (!orderNumber) return reply.status(200).send({ ok: true })

    const mappedStatus = mapFezStatusToFulfilmentStatus(orderStatus)
    // apps/api has no NATS client — this can only persist the change.
    // apps/worker's delivery-notification cron (polling for a providerStatus
    // change) is what actually tells the merchant/customer; a replayed
    // identical event is naturally a no-op since providerStatus won't have
    // changed.
    await db.update(fulfilments)
      .set({
        providerStatus: orderStatus,
        ...(mappedStatus ? { status: mappedStatus } : {}),
        ...(trackingUrl ? { trackingUrl } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(fulfilments.provider, 'FEZ'), eq(fulfilments.providerOrderId, orderNumber)))

    return reply.status(200).send({ ok: true })
  })
}
