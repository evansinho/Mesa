const mockSendTemplate = jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.test' }] })

jest.mock('@mesa/whatsapp', () => ({
  sendTemplate: (...args: unknown[]) => mockSendTemplate(...args),
}))

import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { merchants, merchantChannels } from '@mesa/db'
import { whatsappRoutes } from '../../src/routes/whatsapp'
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
  await app.register(whatsappRoutes, { prefix: '/whatsapp' })
  return app
}

describe('WhatsApp embedded signup routes', () => {
  const originalFetch = global.fetch
  const originalMetaAppId = process.env.META_APP_ID
  const originalMetaAppSecret = process.env.META_APP_SECRET

  beforeEach(() => {
    process.env.META_APP_ID = 'test-meta-app'
    process.env.META_APP_SECRET = 'test-meta-secret'
    mockSendTemplate.mockReset()
    mockSendTemplate.mockResolvedValue({ messages: [{ id: 'wamid.test' }] })
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'token_123' }), { status: 200 })
      }
      if (url.includes('/subscribed_apps')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      if (url.includes('/phone_123')) {
        return new Response(JSON.stringify({ id: 'phone_123' }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as jest.MockedFunction<typeof fetch>
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env.META_APP_ID = originalMetaAppId
    process.env.META_APP_SECRET = originalMetaAppSecret
  })

  it('links an existing WhatsApp Business App number and stores coexistence metadata', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, {
      phone: '+2348012345678',
      config: { paymentInstructions: 'Transfer to bank' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/embedded-signup',
      headers: await createSessionHeaders(db, merchant.id),
      payload: {
        merchantId: merchant.id,
        code: 'code_123',
        phoneNumberId: 'phone_123',
        wabaId: 'waba_123',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ok: true,
      wabaId: 'waba_123',
      phoneNumberId: 'phone_123',
    })

    const channel = await db.query.merchantChannels.findFirst({
      where: eq(merchantChannels.channelAccountId, 'phone_123'),
    })
    expect(channel).toMatchObject({
      merchantId: merchant.id,
      channel: 'whatsapp',
      channelAccountId: 'phone_123',
      accessToken: 'token_123',
      status: 'connected',
    })

    const refreshed = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchant.id),
    })
    expect(refreshed?.config).toMatchObject({
      paymentInstructions: 'Transfer to bank',
      whatsapp: {
        wabaId: 'waba_123',
        phoneNumberId: 'phone_123',
        onboardingMode: 'business_app_coexistence',
      },
      onboarding: {
        status: 'incomplete',
        step: 'SETUP',
      },
    })
    expect(mockSendTemplate).not.toHaveBeenCalled()
  })

  it('does not send a WhatsApp template before onboarding is complete', async () => {
    mockSendTemplate.mockRejectedValueOnce(new Error('Meta send failed'))

    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/embedded-signup',
      headers: await createSessionHeaders(db, merchant.id),
      payload: {
        merchantId: merchant.id,
        code: 'code_123',
        phoneNumberId: 'phone_123',
        wabaId: 'waba_123',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ok: true,
    })
    expect(mockSendTemplate).not.toHaveBeenCalled()

    const channel = await db.query.merchantChannels.findFirst({
      where: eq(merchantChannels.channelAccountId, 'phone_123'),
    })
    expect(channel?.merchantId).toBe(merchant.id)
  })

  it('rejects a WhatsApp number already connected to another merchant', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)
    await createMerchantChannel(db, merchantA.id, {
      channel: 'whatsapp',
      channelAccountId: 'phone_123',
      accessToken: 'token_a',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/embedded-signup',
      headers: await createSessionHeaders(db, merchantB.id),
      payload: {
        merchantId: merchantB.id,
        code: 'code_123',
        phoneNumberId: 'phone_123',
        wabaId: 'waba_123',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(mockSendTemplate).not.toHaveBeenCalled()
  })
})
