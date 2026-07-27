import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { merchantChannels } from '@mesa/db'
import { authRoutes } from '../../src/routes/auth'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(authRoutes, { prefix: '/auth' })
  return app
}

function signedRequest(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url')
  return `${signature}.${encodedPayload}`
}

describe('Meta-called callbacks (data deletion / deauthorize) — must be reachable without credentials', () => {
  const originalIgSecret = process.env.INSTAGRAM_APP_SECRET

  beforeEach(() => {
    process.env.INSTAGRAM_APP_SECRET = 'test-ig-app-secret'
  })

  afterEach(() => {
    process.env.INSTAGRAM_APP_SECRET = originalIgSecret
  })

  it('POST /auth/data-deletion succeeds with no auth headers at all — F-16 regression (previously 401)', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/auth/data-deletion' })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { url: string; confirmation_code: string }
    expect(body.url).toBeTruthy()
    expect(body.confirmation_code).toBeTruthy()
  })

  it('POST /auth/deauthorize with no auth headers and no signed_request just acks', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/auth/deauthorize', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('disconnects the matching Instagram channel when the signed_request is validly signed', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_user_789',
      status: 'connected',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deauthorize',
      payload: { signed_request: signedRequest({ user_id: 'ig_user_789' }, 'test-ig-app-secret') },
    })

    expect(res.statusCode).toBe(200)
    const channel = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.channelAccountId, 'ig_user_789') })
    expect(channel?.status).toBe('disconnected')
  })

  it('ignores a signed_request with an invalid signature — does not disconnect anything', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_user_999',
      status: 'connected',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/deauthorize',
      payload: { signed_request: signedRequest({ user_id: 'ig_user_999' }, 'wrong-secret') },
    })

    expect(res.statusCode).toBe(200)
    const channel = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.channelAccountId, 'ig_user_999') })
    expect(channel?.status).toBe('connected')
  })
})
