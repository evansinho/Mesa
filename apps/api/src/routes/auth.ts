import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { authMagicLinks, authSessions, merchants } from '@mesa/db'
import { eq, and, isNull, gt } from 'drizzle-orm'
import { createHash, randomBytes, randomInt } from 'crypto'
import { config } from '@mesa/config'
import { sendAuthenticationCode, sendText } from '@mesa/whatsapp'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  const national = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${national}`
}

function generateLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

async function createSession(db: Db, merchantId: string) {
  const sessionToken = randomBytes(32).toString('hex')
  const sessionHash = hashToken(sessionToken)
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  await db.insert(authSessions).values({
    merchantId,
    sessionHash,
    expiresAt: sessionExpires,
  })

  return { sessionToken, merchantId }
}

export async function authRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  app.post<{ Body: { phone: string } }>('/request', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { phone } = req.body
    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.phone, normalizePhone(phone)),
    })
    if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

    const code = generateLoginCode()
    const tokenHash = hashToken(code)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash,
      expiresAt,
    })

    try {
      if (config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID) {
        if (config.WHATSAPP_LOGIN_TEMPLATE_NAME) {
          await sendAuthenticationCode(
            merchant.phone,
            config.WHATSAPP_LOGIN_TEMPLATE_NAME,
            code,
            { languageCode: config.WHATSAPP_LOGIN_TEMPLATE_LANGUAGE },
          )
        } else {
          await sendText(merchant.phone, `Your Mesa login code is ${code}. It expires in 15 minutes.`)
        }
      }
    } catch (err) {
      app.log.warn({ err, merchantId: merchant.id }, 'Failed to send login code via WhatsApp')
    }

    return reply.status(200).send({
      ok: true,
      ...(config.NODE_ENV !== 'production' ? { code } : {}),
    })
  })

  app.post<{ Body: { token?: string; phone?: string; code?: string } }>('/verify', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { token, phone, code } = req.body
    const verificationValue = token ?? code?.replace(/\D/g, '')
    if (!verificationValue) return reply.status(400).send({ error: 'Code required' })

    const tokenHash = hashToken(verificationValue)

    if (code) {
      if (!phone) return reply.status(400).send({ error: 'Phone required' })

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.phone, normalizePhone(phone)),
      })
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

      const link = await db.query.authMagicLinks.findFirst({
        where: and(
          eq(authMagicLinks.merchantId, merchant.id),
          eq(authMagicLinks.tokenHash, tokenHash),
          isNull(authMagicLinks.usedAt),
          gt(authMagicLinks.expiresAt, new Date())
        ),
      })
      if (!link) return reply.status(400).send({ error: 'Invalid or expired code' })

      await db.update(authMagicLinks)
        .set({ usedAt: new Date() })
        .where(eq(authMagicLinks.id, link.id))

      return reply.status(200).send({ ok: true, ...(await createSession(db, link.merchantId)) })
    }

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

    return reply.status(200).send({ ok: true, ...(await createSession(db, link.merchantId)) })
  })

  app.post('/data-deletion', async (_req, reply) => {
    return reply.status(200).send({
      url: 'https://getmesa.co/privacy',
      confirmation_code: randomBytes(8).toString('hex'),
    })
  })
}
