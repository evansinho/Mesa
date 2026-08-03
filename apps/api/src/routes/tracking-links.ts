import type { FastifyInstance } from 'fastify'
import { randomInt } from 'crypto'
import { eq } from 'drizzle-orm'
import Redis from 'ioredis'
import { config } from '@mesa/config'
import type { Db } from '@mesa/db'
import { trackingLinks, trackingLinkClicks, merchants } from '@mesa/db'
import {
  TRACKING_LINK_PLATFORMS,
  TRACKING_LINK_GREETING,
  TRACKING_LINK_CLICK_WINDOW_SECONDS,
  type TrackingLinkPlatform,
} from '@mesa/types'

// Not hashed like agentTasks' one-time action tokens — this is a public
// marketing link a merchant publishes on TikTok/Instagram/Facebook, meant to
// be seen, not kept secret. Same ambiguity-free alphabet as the Instagram
// activation code, though casing doesn't matter here since nobody types it.
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const SLUG_LENGTH = 8

export function generateSlug(): string {
  let slug = ''
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)]
  }
  return slug
}

export function isTrackingLinkPlatform(value: string): value is TrackingLinkPlatform {
  return (TRACKING_LINK_PLATFORMS as readonly string[]).includes(value)
}

export function trackingLinkUrl(slug: string): string {
  return `${config.API_PUBLIC_URL}/l/${slug}`
}

// Public redirect: GET /l/:slug — no auth, this is what a customer's phone
// actually opens after tapping the link in a merchant's bio.
export async function trackingLinkRedirectRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db
  const redis = new Redis(config.REDIS_URL)
  redis.on('error', (error) => app.log.error({ error }, 'Tracking link redirect Redis error'))
  app.addHook('onClose', async () => {
    redis.disconnect()
  })

  app.get<{ Params: { slug: string } }>('/:slug', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const link = await db.query.trackingLinks.findFirst({
      where: eq(trackingLinks.slug, req.params.slug),
    })
    if (!link || !isTrackingLinkPlatform(link.platform)) {
      return reply.status(404).send({ error: 'Not found' })
    }

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, link.merchantId),
      columns: { phone: true },
    })
    if (!merchant) return reply.status(404).send({ error: 'Not found' })

    await db.insert(trackingLinkClicks).values({
      trackingLinkId: link.id,
      merchantId: link.merchantId,
      platform: link.platform,
    })

    // Correlation signal for resolveInboundSource (apps/worker) — apps/api
    // and apps/worker share the same Redis instance, so this is read
    // directly, no event hop needed.
    await redis.set(
      `click:${link.merchantId}:${link.platform}`,
      new Date().toISOString(),
      'EX',
      TRACKING_LINK_CLICK_WINDOW_SECONDS,
    ).catch((error) => app.log.error({ error }, 'Failed to record tracking-link click for correlation'))

    const greeting = TRACKING_LINK_GREETING[link.platform]
    const waUrl = `https://wa.me/${merchant.phone.replace(/\D/g, '')}?text=${encodeURIComponent(greeting)}`
    return reply.redirect(waUrl, 302)
  })
}
