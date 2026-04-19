import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { authMagicLinks, authSessions, merchants } from '@mesa/db'
import { eq, and, isNull, gt } from 'drizzle-orm'
import { createHash, randomBytes } from 'crypto'
import { config } from '@mesa/config'
import { sendText } from '@mesa/whatsapp'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function authRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  app.post<{ Body: { phone: string } }>('/request', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { phone } = req.body
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.phone, phone),
    })
    if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

    const token = randomBytes(24).toString('hex')
    const tokenHash = hashToken(token)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash,
      expiresAt,
    })

    const link = `${config.DASHBOARD_URL}/login/callback?token=${token}`

    try {
      if (config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID) {
        await sendText(phone, `Mesa login link: ${link}`)
      }
    } catch (err) {
      app.log.warn({ err, merchantId: merchant.id }, 'Failed to send magic link via WhatsApp')
    }

    return reply.status(200).send({ ok: true, link })
  })

  app.post<{ Body: { token: string } }>('/verify', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { token } = req.body
    const tokenHash = hashToken(token)

    const link = await db.query.authMagicLinks.findFirst({
      where: and(
        eq(authMagicLinks.tokenHash, tokenHash),
        isNull(authMagicLinks.usedAt),
        gt(authMagicLinks.expiresAt, new Date())
      ),
    })
    if (!link) return reply.status(400).send({ error: 'Invalid or expired token' })

    await db.update(authMagicLinks)
      .set({ usedAt: new Date() })
      .where(eq(authMagicLinks.id, link.id))

    const sessionToken = randomBytes(32).toString('hex')
    const sessionHash = hashToken(sessionToken)
    const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await db.insert(authSessions).values({
      merchantId: link.merchantId,
      sessionHash,
      expiresAt: sessionExpires,
    })

    return reply.status(200).send({ ok: true, sessionToken, merchantId: link.merchantId })
  })

  app.post('/data-deletion', async (_req, reply) => {
    return reply.status(200).send({
      url: 'https://getmesa.co/privacy',
      confirmation_code: randomBytes(8).toString('hex'),
    })
  })
}
