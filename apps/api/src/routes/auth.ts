import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { authMagicLinks, authSessions, merchants, merchantChannels } from '@mesa/db'
import { eq, and, isNull, gt } from 'drizzle-orm'
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { config } from '@mesa/config'
import { sendAuthenticationCode, sendText } from '@mesa/whatsapp'
import { normalizePhone } from '@mesa/types'

// Meta's signed_request format: "<base64url signature>.<base64url JSON payload>",
// signature = HMAC-SHA256(payload, app secret). Used by the deauthorize
// callback so a spoofed request can't disconnect an arbitrary merchant's
// channel — tries each candidate secret since which app (Instagram Login's
// companion app vs. the parent Meta app) actually signs isn't documented.
function verifySignedRequest(signedRequest: string, secrets: Array<string | undefined>): Record<string, unknown> | null {
  const [encodedSig, encodedPayload] = signedRequest.split('.')
  if (!encodedSig || !encodedPayload) return null

  const providedSig = Buffer.from(encodedSig, 'base64url')
  const matches = [...new Set(secrets.filter((s): s is string => Boolean(s)))].some(secret => {
    const expectedSig = createHmac('sha256', secret).update(encodedPayload).digest()
    return expectedSig.length === providedSig.length && timingSafeEqual(expectedSig, providedSig)
  })
  if (!matches) return null

  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000
const REQUEST_COOLDOWN_MS = 30 * 1000
const INVALID_CODE_ERROR = { error: 'Invalid or expired code' }
const TOO_MANY_ATTEMPTS_ERROR = { error: 'Too many failed attempts. Try again later.' }

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
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

// Called on a failed /verify attempt. Locks the merchant out of further
// attempts for LOCKOUT_DURATION_MS once MAX_FAILED_ATTEMPTS is reached.
async function registerFailedAttempt(db: Db, merchantId: string, currentAttempts: number): Promise<void> {
  const attempts = currentAttempts + 1
  const lockedOut = attempts >= MAX_FAILED_ATTEMPTS
  await db.update(merchants)
    .set({
      failedLoginAttempts: lockedOut ? 0 : attempts,
      loginLockedUntil: lockedOut ? new Date(Date.now() + LOCKOUT_DURATION_MS) : undefined,
    })
    .where(eq(merchants.id, merchantId))
}

async function clearFailedAttempts(db: Db, merchantId: string): Promise<void> {
  await db.update(merchants)
    .set({ failedLoginAttempts: 0, loginLockedUntil: null })
    .where(eq(merchants.id, merchantId))
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
    // Always respond identically whether or not the phone is registered —
    // otherwise this endpoint becomes a merchant-existence oracle.
    if (!merchant) return reply.status(200).send({ ok: true })

    const lastLink = await db.query.authMagicLinks.findFirst({
      where: eq(authMagicLinks.merchantId, merchant.id),
      orderBy: (links, { desc }) => [desc(links.createdAt)],
    })
    if (lastLink && Date.now() - lastLink.createdAt.getTime() < REQUEST_COOLDOWN_MS) {
      return reply.status(200).send({ ok: true })
    }

    const code = generateLoginCode()
    const tokenHash = hashToken(code)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    // A new code invalidates any still-outstanding ones, so only one code
    // is ever guessable at a time.
    await db.update(authMagicLinks)
      .set({ usedAt: new Date() })
      .where(and(eq(authMagicLinks.merchantId, merchant.id), isNull(authMagicLinks.usedAt)))

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

      // Meta App Review reviewer bypass — a reviewer can't receive a
      // WhatsApp OTP sent to a number they don't hold. Scoped to exactly
      // one phone+code pair, and only active when both are configured
      // (unset in any environment where reviewer access isn't needed).
      // Falls through to the normal path below on any mismatch, which
      // correctly 400s without revealing which part didn't match.
      const reviewPhone = config.APP_REVIEW_TEST_PHONE
      const reviewCode = config.APP_REVIEW_TEST_CODE
      if (reviewPhone && reviewCode && normalizePhone(phone) === normalizePhone(reviewPhone)) {
        const codeBuf = Buffer.from(code)
        const expectedBuf = Buffer.from(reviewCode)
        const codeMatches = codeBuf.length === expectedBuf.length && timingSafeEqual(codeBuf, expectedBuf)
        if (codeMatches) {
          const reviewMerchant = await db.query.merchants.findFirst({
            where: eq(merchants.phone, normalizePhone(reviewPhone)),
          })
          if (reviewMerchant) {
            return reply.status(200).send({ ok: true, ...(await createSession(db, reviewMerchant.id)) })
          }
        }
      }

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.phone, normalizePhone(phone)),
      })
      if (!merchant) return reply.status(400).send(INVALID_CODE_ERROR)

      if (merchant.loginLockedUntil && merchant.loginLockedUntil > new Date()) {
        return reply.status(429).send(TOO_MANY_ATTEMPTS_ERROR)
      }

      const link = await db.query.authMagicLinks.findFirst({
        where: and(
          eq(authMagicLinks.merchantId, merchant.id),
          eq(authMagicLinks.tokenHash, tokenHash),
          isNull(authMagicLinks.usedAt),
          gt(authMagicLinks.expiresAt, new Date())
        ),
      })
      if (!link) {
        await registerFailedAttempt(db, merchant.id, merchant.failedLoginAttempts)
        return reply.status(400).send(INVALID_CODE_ERROR)
      }

      await db.update(authMagicLinks)
        .set({ usedAt: new Date() })
        .where(eq(authMagicLinks.id, link.id))
      await clearFailedAttempts(db, merchant.id)

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

  app.post('/logout', async (req, reply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Unauthorized' })

    const sessionHash = hashToken(authHeader.slice(7))
    await db.delete(authSessions).where(eq(authSessions.sessionHash, sessionHash))

    return reply.status(200).send({ ok: true })
  })

  app.post('/data-deletion', async (_req, reply) => {
    return reply.status(200).send({
      url: 'https://getmesa.co/privacy',
      confirmation_code: randomBytes(8).toString('hex'),
    })
  })

  // Meta calls this when a user revokes the app's access (e.g. Instagram
  // Business Login). Mirrors what /instagram/disconnect does, triggered by
  // Meta instead of the merchant — must always return 200 regardless of
  // whether a matching channel was found.
  app.post<{ Body: { signed_request?: string } }>('/deauthorize', async (req, reply) => {
    const signedRequest = req.body?.signed_request
    if (signedRequest) {
      const payload = verifySignedRequest(signedRequest, [config.INSTAGRAM_APP_SECRET, config.META_APP_SECRET])
      const userId = payload?.user_id != null ? String(payload.user_id) : undefined
      if (userId) {
        await db.update(merchantChannels)
          .set({ status: 'disconnected' })
          .where(and(eq(merchantChannels.channel, 'instagram'), eq(merchantChannels.channelAccountId, userId)))
      }
    }
    return reply.status(200).send({ ok: true })
  })
}
