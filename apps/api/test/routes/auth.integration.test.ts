// Mock the WhatsApp sendText so /auth/request doesn't try to call Meta.
const mockSendText = jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.text' }] })
const mockSendTemplate = jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.template' }] })
const mockSendAuthenticationCode = jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.auth' }] })

jest.mock('@mesa/whatsapp', () => ({
  sendText: (...args: unknown[]) => mockSendText(...args),
  sendTemplate: (...args: unknown[]) => mockSendTemplate(...args),
  sendAuthenticationCode: (...args: unknown[]) => mockSendAuthenticationCode(...args),
}))

import { createHash, createHmac } from 'crypto'
import { eq, and, isNull } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import formbody from '@fastify/formbody'
import { config } from '@mesa/config'
import { authMagicLinks, authSessions, merchants, merchantChannels } from '@mesa/db'
import { authRoutes } from '../../src/routes/auth'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'

function signMetaRequest(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(encodedPayload).digest('base64url')
  return `${sig}.${encodedPayload}`
}

setupIntegration()

const originalLoginTemplateName = config.WHATSAPP_LOGIN_TEMPLATE_NAME
const originalLoginTemplateLanguage = config.WHATSAPP_LOGIN_TEMPLATE_LANGUAGE
const originalReviewPhone = config.APP_REVIEW_TEST_PHONE
const originalReviewCode = config.APP_REVIEW_TEST_CODE

afterEach(() => {
  config.WHATSAPP_LOGIN_TEMPLATE_NAME = originalLoginTemplateName
  config.WHATSAPP_LOGIN_TEMPLATE_LANGUAGE = originalLoginTemplateLanguage
  config.APP_REVIEW_TEST_PHONE = originalReviewPhone
  config.APP_REVIEW_TEST_CODE = originalReviewCode
})

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  // Matches production's index.ts registration — Meta's deauthorize/
  // data-deletion callbacks POST application/x-www-form-urlencoded, which
  // Fastify's default JSON-only parser rejects with a 415 before the route
  // handler ever runs.
  await app.register(formbody)
  app.decorate('db', getTestDb())
  await app.register(authRoutes, { prefix: '/auth' })
  return app
}

describe('Auth routes (integration)', () => {
  it('POST /auth/request returns 200 for an unknown phone without revealing it (no enumeration)', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request',
      payload: { phone: '+2348099991234' },
    })
    expect(res.statusCode).toBe(200)
    expect(mockSendText).not.toHaveBeenCalled()
    expect(mockSendTemplate).not.toHaveBeenCalled()
    expect(mockSendAuthenticationCode).not.toHaveBeenCalled()
  })

  it('POST /auth/request inserts a login-code row for a known merchant', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request',
      payload: { phone: '+2348012345678' },
    })
    expect(res.statusCode).toBe(200)

    const links = await db.query.authMagicLinks.findMany({
      where: eq(authMagicLinks.merchantId, merchant.id),
    })
    expect(links).toHaveLength(1)
    expect(links[0].tokenHash).toMatch(/^[a-f0-9]{64}$/) // SHA256 hex
    expect(links[0].usedAt).toBeNull()
    expect(mockSendText).toHaveBeenCalledWith(
      merchant.phone,
      expect.stringMatching(/^Your Mesa login code is \d{6}\. It expires in 15 minutes\.$/),
    )
    expect(mockSendTemplate).not.toHaveBeenCalled()
    expect(mockSendAuthenticationCode).not.toHaveBeenCalled()
  })

  it('POST /auth/request sends no code for a deactivated (soft-deleted) merchant — same non-enumerating 200 as an unknown phone', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678', active: false })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request',
      payload: { phone: '+2348012345678' },
    })
    expect(res.statusCode).toBe(200)
    expect(mockSendText).not.toHaveBeenCalled()
    expect(mockSendTemplate).not.toHaveBeenCalled()
    expect(mockSendAuthenticationCode).not.toHaveBeenCalled()

    const links = await db.query.authMagicLinks.findMany({ where: eq(authMagicLinks.merchantId, merchant.id) })
    expect(links).toHaveLength(0)
  })

  it('POST /auth/request uses WhatsApp template when configured', async () => {
    config.WHATSAPP_LOGIN_TEMPLATE_NAME = 'mesa_login_code'
    config.WHATSAPP_LOGIN_TEMPLATE_LANGUAGE = 'en'

    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request',
      payload: { phone: '+2348012345678' },
    })
    expect(res.statusCode).toBe(200)
    expect(mockSendAuthenticationCode).toHaveBeenCalledWith(
      merchant.phone,
      'mesa_login_code',
      expect.stringMatching(/^\d{6}$/),
      { languageCode: 'en' },
    )
    expect(mockSendText).not.toHaveBeenCalled()
    expect(mockSendTemplate).not.toHaveBeenCalled()
  })

  it('POST /auth/request normalizes Nigerian phone formats', async () => {
    const app = await buildApp()
    const db = getTestDb()
    await createMerchant(db, { phone: '+2348012345678' })

    // Local 08… form should resolve to the +234 merchant.
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request',
      payload: { phone: '08012345678' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('POST /auth/verify with a valid token returns sessionToken + merchantId', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const rawToken = 'a'.repeat(48) // 24 random bytes → 48 hex chars
    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token: rawToken },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { sessionToken: string; merchantId: string }
    expect(body.sessionToken).toMatch(/^[a-f0-9]{64}$/) // 32 bytes hex
    expect(body.merchantId).toBe(merchant.id)

    // Session row inserted with sessionHash, never plaintext.
    const sessions = await db.query.authSessions.findMany({
      where: eq(authSessions.merchantId, merchant.id),
    })
    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionHash).toBe(
      createHash('sha256').update(body.sessionToken).digest('hex'),
    )
  })

  it('POST /auth/verify with a valid phone code returns sessionToken + merchantId', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    const rawCode = '123456'
    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update(rawCode).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '08012345678', code: rawCode },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { sessionToken: string; merchantId: string }
    expect(body.sessionToken).toMatch(/^[a-f0-9]{64}$/)
    expect(body.merchantId).toBe(merchant.id)
  })

  it('POST /auth/verify rejects a valid token for a deactivated merchant, without minting a session', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { active: false })
    const rawToken = 'b'.repeat(48)
    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token: rawToken },
    })
    expect(res.statusCode).toBe(400)
    const sessions = await db.query.authSessions.findMany({ where: eq(authSessions.merchantId, merchant.id) })
    expect(sessions).toHaveLength(0)
  })

  it('POST /auth/verify rejects a valid phone code for a deactivated merchant, without minting a session', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678', active: false })
    const rawCode = '654321'
    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update(rawCode).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '08012345678', code: rawCode },
    })
    expect(res.statusCode).toBe(400)
    const sessions = await db.query.authSessions.findMany({ where: eq(authSessions.merchantId, merchant.id) })
    expect(sessions).toHaveLength(0)
  })

  it('POST /auth/verify logs in the reviewer test merchant with the configured phone+code, bypassing the OTP entirely', async () => {
    config.APP_REVIEW_TEST_PHONE = '+2348000000001'
    config.APP_REVIEW_TEST_CODE = '91398370'
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348000000001' })

    // No authMagicLinks row exists at all — this must work without one.
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '+2348000000001', code: '91398370' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { sessionToken: string; merchantId: string }
    expect(body.merchantId).toBe(merchant.id)
  })

  it('POST /auth/verify does not bypass when APP_REVIEW_TEST_PHONE/CODE are unset — the default in every real environment', async () => {
    config.APP_REVIEW_TEST_PHONE = undefined
    config.APP_REVIEW_TEST_CODE = undefined
    const app = await buildApp()
    const db = getTestDb()
    await createMerchant(db, { phone: '+2348000000001' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '+2348000000001', code: '91398370' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST /auth/verify rejects the wrong code for the reviewer test phone — falls through to the normal invalid-code path', async () => {
    config.APP_REVIEW_TEST_PHONE = '+2348000000001'
    config.APP_REVIEW_TEST_CODE = '91398370'
    const app = await buildApp()
    const db = getTestDb()
    await createMerchant(db, { phone: '+2348000000001' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '+2348000000001', code: 'wrong123' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST /auth/verify does not let the reviewer code work for a different phone number', async () => {
    config.APP_REVIEW_TEST_PHONE = '+2348000000001'
    config.APP_REVIEW_TEST_CODE = '91398370'
    const app = await buildApp()
    const db = getTestDb()
    await createMerchant(db, { phone: '+2348012345678' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '+2348012345678', code: '91398370' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST /auth/verify rejects an expired token', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const rawToken = 'b'.repeat(48)
    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token: rawToken },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /auth/verify rejects an already-used token', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const rawToken = 'c'.repeat(48)
    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      usedAt: new Date(),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token: rawToken },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /auth/verify marks the magic link as used', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const rawToken = 'd'.repeat(48)
    const [link] = await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    }).returning()

    await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token: rawToken },
    })

    const refreshed = await db.query.authMagicLinks.findFirst({
      where: eq(authMagicLinks.id, link.id),
    })
    expect(refreshed?.usedAt).not.toBeNull()
  })

  it('POST /auth/request invalidates a previous outstanding code', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    await app.inject({ method: 'POST', url: '/auth/request', payload: { phone: '+2348012345678' } })
    const [firstLink] = await db.query.authMagicLinks.findMany({
      where: eq(authMagicLinks.merchantId, merchant.id),
    })

    // Force past the request cooldown so the second /request isn't a no-op.
    await db.update(authMagicLinks).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(authMagicLinks.id, firstLink.id))

    await app.inject({ method: 'POST', url: '/auth/request', payload: { phone: '+2348012345678' } })

    const refreshedFirst = await db.query.authMagicLinks.findFirst({ where: eq(authMagicLinks.id, firstLink.id) })
    expect(refreshedFirst?.usedAt).not.toBeNull()

    const stillOutstanding = await db.query.authMagicLinks.findMany({
      where: and(eq(authMagicLinks.merchantId, merchant.id), isNull(authMagicLinks.usedAt)),
    })
    expect(stillOutstanding).toHaveLength(1)
  })

  it('POST /auth/request within the cooldown window does not issue a second code', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    await app.inject({ method: 'POST', url: '/auth/request', payload: { phone: '+2348012345678' } })
    await app.inject({ method: 'POST', url: '/auth/request', payload: { phone: '+2348012345678' } })

    const links = await db.query.authMagicLinks.findMany({ where: eq(authMagicLinks.merchantId, merchant.id) })
    expect(links).toHaveLength(1)
  })

  it('POST /auth/verify locks the merchant out after 5 failed attempts', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update('123456').digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { phone: '+2348012345678', code: '000000' },
      })
      expect(res.statusCode).toBe(400)
    }

    // Even the correct code is now rejected while locked out.
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '+2348012345678', code: '123456' },
    })
    expect(res.statusCode).toBe(429)

    const refreshed = await db.query.merchants.findFirst({ where: eq(merchants.id, merchant.id) })
    expect(refreshed?.loginLockedUntil).not.toBeNull()
  })

  it('POST /auth/verify success clears any prior failed-attempt count', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678', failedLoginAttempts: 3 })
    await db.insert(authMagicLinks).values({
      merchantId: merchant.id,
      tokenHash: createHash('sha256').update('654321').digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { phone: '+2348012345678', code: '654321' },
    })
    expect(res.statusCode).toBe(200)

    const refreshed = await db.query.merchants.findFirst({ where: eq(merchants.id, merchant.id) })
    expect(refreshed?.failedLoginAttempts).toBe(0)
  })

  it('POST /auth/logout deletes the presented session', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const rawToken = 'e'.repeat(48)
    await db.insert(authSessions).values({
      merchantId: merchant.id,
      sessionHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${rawToken}` },
    })
    expect(res.statusCode).toBe(200)

    const sessions = await db.query.authSessions.findMany({ where: eq(authSessions.merchantId, merchant.id) })
    expect(sessions).toHaveLength(0)
  })

  it('POST /auth/logout without a Bearer token returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/auth/logout' })
    expect(res.statusCode).toBe(401)
  })

  it('POST /auth/deauthorize accepts Meta\'s form-urlencoded signed_request and disconnects the Instagram channel — 415 regression', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const channel = await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig-user-123',
      status: 'connected',
    })

    const signedRequest = signMetaRequest({ user_id: 'ig-user-123' }, config.META_APP_SECRET as string)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deauthorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `signed_request=${encodeURIComponent(signedRequest)}`,
    })

    expect(res.statusCode).toBe(200)
    const updated = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
    expect(updated?.status).toBe('disconnected')
  })

  it('POST /auth/data-deletion accepts a form-urlencoded body and returns the required confirmation shape', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/data-deletion',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'signed_request=irrelevant-for-this-endpoint',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { url: string; confirmation_code: string }
    expect(body.url).toBe('https://getmesa.co/privacy')
    expect(body.confirmation_code).toBeTruthy()
  })
})
