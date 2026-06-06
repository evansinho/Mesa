// Mock the WhatsApp sendText so /auth/request doesn't try to call Meta.
const mockSendText = jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.text' }] })
const mockSendTemplate = jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.template' }] })

jest.mock('@mesa/whatsapp', () => ({
  sendText: (...args: unknown[]) => mockSendText(...args),
  sendTemplate: (...args: unknown[]) => mockSendTemplate(...args),
}))

import { createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { config } from '@mesa/config'
import { authMagicLinks, authSessions } from '@mesa/db'
import { authRoutes } from '../../src/routes/auth'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant } from '@test-helpers/factories'

setupIntegration()

const originalLoginTemplateName = config.WHATSAPP_LOGIN_TEMPLATE_NAME
const originalLoginTemplateLanguage = config.WHATSAPP_LOGIN_TEMPLATE_LANGUAGE

afterEach(() => {
  config.WHATSAPP_LOGIN_TEMPLATE_NAME = originalLoginTemplateName
  config.WHATSAPP_LOGIN_TEMPLATE_LANGUAGE = originalLoginTemplateLanguage
})

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.decorate('db', getTestDb())
  await app.register(authRoutes, { prefix: '/auth' })
  return app
}

describe('Auth routes (integration)', () => {
  it('POST /auth/request returns 404 for an unknown phone', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request',
      payload: { phone: '+2348099991234' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('POST /auth/request inserts a magic-link row for a known merchant', async () => {
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
      expect.stringContaining(`${process.env.DASHBOARD_URL ?? 'http://localhost:3000'}/login/callback?token=`),
    )
    expect(mockSendTemplate).not.toHaveBeenCalled()
  })

  it('POST /auth/request uses WhatsApp template when configured', async () => {
    config.WHATSAPP_LOGIN_TEMPLATE_NAME = 'mesa_login_link'
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
    expect(mockSendTemplate).toHaveBeenCalledWith(
      merchant.phone,
      'mesa_login_link',
      [expect.stringContaining('/login/callback?token=')],
      { languageCode: 'en' },
    )
    expect(mockSendText).not.toHaveBeenCalled()
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
})
