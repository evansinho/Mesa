import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { merchantChannels, platformInstagramAccount } from '@mesa/db'
import { instagramRoutes, platformInstagramConnectToken } from '../../src/routes/instagram'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'
import { createSessionHeaders, internalAuthHeaders } from '@test-helpers/auth'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(instagramRoutes, { prefix: '/instagram' })
  return app
}

describe('Instagram embedded signup routes (Instagram API with Instagram Login)', () => {
  const originalFetch = global.fetch
  const originalIgAppId = process.env.INSTAGRAM_APP_ID
  const originalIgAppSecret = process.env.INSTAGRAM_APP_SECRET

  beforeEach(() => {
    process.env.INSTAGRAM_APP_ID = 'test-ig-app'
    process.env.INSTAGRAM_APP_SECRET = 'test-ig-secret'
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('api.instagram.com/oauth/access_token')) {
        // Deliberately a different value than /me's user_id below — Meta's
        // OAuth-exchange user_id is a DIFFERENT ID namespace than what
        // webhooks actually deliver as entry.id, and must never be what
        // gets stored as channelAccountId. See fetchInstagramAccountInfo.
        return new Response(JSON.stringify({ access_token: 'short_lived_token_123', user_id: 'oauth_exchange_wrong_namespace_id' }), { status: 200 })
      }
      if (url.includes('graph.instagram.com/access_token')) {
        return new Response(JSON.stringify({ access_token: 'long_lived_token_123', expires_in: 5183944 }), { status: 200 })
      }
      if (url.includes('graph.instagram.com/v21.0/me') && !url.includes('subscribed_apps')) {
        // This is the ID namespace webhooks actually use as entry.id —
        // the correct value to store as channelAccountId.
        return new Response(JSON.stringify({ user_id: 'ig_user_456', username: 'sino_shop' }), { status: 200 })
      }
      if (url.includes('subscribed_apps')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as jest.MockedFunction<typeof fetch>
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env.INSTAGRAM_APP_ID = originalIgAppId
    process.env.INSTAGRAM_APP_SECRET = originalIgAppSecret
  })

  it('connects a fresh Instagram account: exchanges for a long-lived token and returns a verification link pointing at Mesa\'s own account, not the merchant\'s', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await db.insert(platformInstagramAccount).values({
      accountId: 'ig_mesa_platform',
      username: 'mesa_hq',
      accessToken: 'mesa_platform_token',
      tokenRefreshedAt: new Date(),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/instagram/embedded-signup',
      headers: await createSessionHeaders(db, merchant.id),
      payload: { merchantId: merchant.id, code: 'code_123', redirectUri: 'https://app.test/callback' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; instagramAccountId: string; verificationUrl?: string; verificationUsername?: string }
    expect(body).toMatchObject({ ok: true, instagramAccountId: 'ig_user_456', verificationUsername: 'mesa_hq' })
    // Points at Mesa's own @mesa_hq account, never the merchant's own just-connected shop account.
    expect(body.verificationUrl).toBe('https://ig.me/m/mesa_hq?ref='
      + (await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.channelAccountId, 'ig_user_456') }))?.id)

    const channel = await db.query.merchantChannels.findFirst({
      where: eq(merchantChannels.channelAccountId, 'ig_user_456'),
    })
    expect(channel).toMatchObject({
      merchantId: merchant.id,
      channel: 'instagram',
      channelAccountId: 'ig_user_456',
      accessToken: 'long_lived_token_123', // the long-lived token, not the short-lived one
      status: 'connected',
      merchantRecipientId: null,
    })
    expect(channel?.tokenRefreshedAt).not.toBeNull()
  })

  it('subscribes the merchant\'s shop account to message_echoes, not just messages/messaging_postbacks — needed to capture the merchant\'s own native replies to customers', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    await app.inject({
      method: 'POST',
      url: '/instagram/embedded-signup',
      headers: await createSessionHeaders(db, merchant.id),
      payload: { merchantId: merchant.id, code: 'code_123', redirectUri: 'https://app.test/callback' },
    })

    const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>
    const subscribeCall = mockFetch.mock.calls.find(([input]) => input.toString().includes('subscribed_apps'))
    expect(subscribeCall?.[0].toString()).toContain('subscribed_fields=messages%2Cmessaging_postbacks%2Cmessage_echoes')
  })

  it('stores the /me user_id as channelAccountId, never the OAuth exchange\'s own user_id — Meta uses a different ID namespace for webhooks', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    await app.inject({
      method: 'POST',
      url: '/instagram/embedded-signup',
      headers: await createSessionHeaders(db, merchant.id),
      payload: { merchantId: merchant.id, code: 'code_123', redirectUri: 'https://app.test/callback' },
    })

    const channel = await db.query.merchantChannels.findFirst({
      where: eq(merchantChannels.channelAccountId, 'ig_user_456'),
    })
    expect(channel).toBeDefined()
    const wrongIdChannel = await db.query.merchantChannels.findFirst({
      where: eq(merchantChannels.channelAccountId, 'oauth_exchange_wrong_namespace_id'),
    })
    expect(wrongIdChannel).toBeUndefined()
  })

  it('omits the verification link when Mesa has no platform Instagram account connected yet', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    const res = await app.inject({
      method: 'POST',
      url: '/instagram/embedded-signup',
      headers: await createSessionHeaders(db, merchant.id),
      payload: { merchantId: merchant.id, code: 'code_123', redirectUri: 'https://app.test/callback' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { verificationUrl?: string }
    expect(body.verificationUrl).toBeUndefined()
  })

  it('reconnecting refreshes the token but never overwrites an already-captured merchantRecipientId', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_user_456',
      accessToken: 'stale_token',
      merchantRecipientId: 'igsid_merchant_789',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/instagram/embedded-signup',
      headers: await createSessionHeaders(db, merchant.id),
      payload: { merchantId: merchant.id, code: 'code_123', redirectUri: 'https://app.test/callback' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { verificationUrl?: string }
    // Already verified — no activation link needed again.
    expect(body.verificationUrl).toBeUndefined()

    const channel = await db.query.merchantChannels.findFirst({
      where: eq(merchantChannels.channelAccountId, 'ig_user_456'),
    })
    expect(channel).toMatchObject({
      accessToken: 'long_lived_token_123', // refreshed
      merchantRecipientId: 'igsid_merchant_789', // preserved
    })
  })

  it('connect-platform-account rejects a missing/invalid capability token', async () => {
    const app = await buildApp()

    const missing = await app.inject({
      method: 'POST',
      url: '/instagram/connect-platform-account',
      payload: { code: 'code_123', redirectUri: 'https://app.test/callback' },
    })
    expect(missing.statusCode).toBe(403)

    const wrong = await app.inject({
      method: 'POST',
      url: '/instagram/connect-platform-account',
      payload: { code: 'code_123', redirectUri: 'https://app.test/callback', token: 'not-the-right-token' },
    })
    expect(wrong.statusCode).toBe(403)
  })

  it('connect-platform-account writes the singleton platformInstagramAccount row with no merchant session at all', async () => {
    const app = await buildApp()
    const db = getTestDb()

    const res = await app.inject({
      method: 'POST',
      url: '/instagram/connect-platform-account',
      payload: { code: 'code_123', redirectUri: 'https://app.test/callback', token: platformInstagramConnectToken() },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; instagramAccountId: string; username?: string }
    expect(body).toMatchObject({ ok: true, instagramAccountId: 'ig_user_456', username: 'sino_shop' })

    const account = await db.query.platformInstagramAccount.findFirst()
    expect(account).toMatchObject({
      accountId: 'ig_user_456',
      username: 'sino_shop',
      accessToken: 'long_lived_token_123',
    })
  })

  it('connect-platform-account rejects a reconnect that presents the bootstrap capability token instead of internal auth — the token must not work forever', async () => {
    const app = await buildApp()
    const db = getTestDb()
    await db.insert(platformInstagramAccount).values({
      accountId: 'ig_user_old',
      username: 'old_mesa_handle',
      accessToken: 'stale_platform_token',
      tokenRefreshedAt: new Date('2026-01-01T00:00:00Z'),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/instagram/connect-platform-account',
      payload: { code: 'code_123', redirectUri: 'https://app.test/callback', token: platformInstagramConnectToken() },
    })

    expect(res.statusCode).toBe(403)
    const accounts = await db.query.platformInstagramAccount.findMany()
    expect(accounts).toMatchObject([{ accountId: 'ig_user_old' }])
  })

  it('connect-platform-account on a reconnect with internal auth replaces the single existing row rather than creating a second one', async () => {
    const app = await buildApp()
    const db = getTestDb()
    await db.insert(platformInstagramAccount).values({
      accountId: 'ig_user_old',
      username: 'old_mesa_handle',
      accessToken: 'stale_platform_token',
      tokenRefreshedAt: new Date('2026-01-01T00:00:00Z'),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/instagram/connect-platform-account',
      headers: internalAuthHeaders(),
      payload: { code: 'code_123', redirectUri: 'https://app.test/callback' },
    })

    expect(res.statusCode).toBe(200)
    const accounts = await db.query.platformInstagramAccount.findMany()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      accountId: 'ig_user_456',
      username: 'sino_shop',
      accessToken: 'long_lived_token_123',
    })
  })

  it('disconnect marks the merchant Instagram channel as disconnected', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_user_456',
      accessToken: 'long_lived_token_123',
      status: 'connected',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/instagram/disconnect',
      headers: await createSessionHeaders(db, merchant.id),
      payload: { merchantId: merchant.id },
    })

    expect(res.statusCode).toBe(200)
    const channel = await db.query.merchantChannels.findFirst({
      where: eq(merchantChannels.channelAccountId, 'ig_user_456'),
    })
    expect(channel?.status).toBe('disconnected')
  })
})
