import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { merchantChannels } from '@mesa/db'
import { instagramRoutes } from '../../src/routes/instagram'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'
import { createSessionHeaders } from '@test-helpers/auth'

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
        return new Response(JSON.stringify({ access_token: 'short_lived_token_123', user_id: 'ig_user_456' }), { status: 200 })
      }
      if (url.includes('graph.instagram.com/access_token')) {
        return new Response(JSON.stringify({ access_token: 'long_lived_token_123', expires_in: 5183944 }), { status: 200 })
      }
      if (url.includes('graph.instagram.com/v21.0/me') && !url.includes('subscribed_apps')) {
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

  it('connects a fresh Instagram account: exchanges for a long-lived token and returns a verification link', async () => {
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
    const body = res.json() as { ok: boolean; instagramAccountId: string; verificationUrl?: string }
    expect(body).toMatchObject({ ok: true, instagramAccountId: 'ig_user_456' })
    expect(body.verificationUrl).toBe('https://ig.me/m/sino_shop?ref='
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
