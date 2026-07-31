import { createHmac } from 'crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { merchantChannels, platformInstagramAccount } from '@mesa/db'
import { config } from '@mesa/config'
import { webhookRoutes } from '../src/routes/webhook'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'

setupIntegration()

function signWith(secretEnvVar: 'META_APP_SECRET' | 'INSTAGRAM_APP_SECRET', body: string): string {
  const secret = process.env[secretEnvVar]
  if (!secret) throw new Error(`${secretEnvVar} must be set in the test environment to sign webhook payloads`)
  const digest = createHmac('sha256', secret).update(body).digest('hex')
  return `sha256=${digest}`
}

function sign(body: string): string {
  return signWith('META_APP_SECRET', body)
}

async function buildApp(natsPublish: jest.Mock): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const redis = getTestRedis()
  ;(app as FastifyInstance & { nats: unknown; redis: unknown }).nats = { publish: natsPublish }
  ;(app as FastifyInstance & { nats: unknown; redis: unknown }).redis = redis
  await app.register(webhookRoutes)
  return app
}

// The webhook handler replies 200 to Meta immediately and processes
// messages afterward (fire-and-forget, so a slow DB write never risks a
// Meta-side retry) — app.inject() resolving only means the reply was sent,
// not that the background work finished. Poll for the expected side effect.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitFor timed out')
}

function instagramPayload(channelAccountId: string, entries: Array<Record<string, unknown>>) {
  return {
    object: 'instagram',
    entry: [{
      id: channelAccountId,
      time: Date.now(),
      messaging: entries,
    }],
  }
}

describe('POST /instagram webhook — merchant DM recognition', () => {
  it('captures the merchant recipient ID and last-message timestamp from the referral-tagged activation DM, without publishing it as a customer message', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const channel = await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
    })

    const payload = instagramPayload('ig_biz_1', [{
      sender: { id: 'igsid_merchant_1' },
      recipient: { id: 'ig_biz_1' },
      timestamp: Date.now(),
      message: { mid: 'mid_referral_1', text: 'Activate' },
      referral: { ref: channel.id },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => {
      const row = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
      return row?.merchantRecipientId === 'igsid_merchant_1'
    })

    expect(natsPublish).not.toHaveBeenCalled()
    const refreshed = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
    expect(refreshed?.merchantRecipientId).toBe('igsid_merchant_1')
    expect(refreshed?.merchantLastMessageAt).not.toBeNull()
  })

  it('captures the merchant recipient ID when referral is nested under message.referral — Meta\'s actual shape for a brand-new thread\'s first composer message (confirmed against their docs), as opposed to top-level referral which only appears on messaging_referral for an existing thread', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const channel = await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_nested_1',
    })

    const payload = instagramPayload('ig_biz_nested_1', [{
      sender: { id: 'igsid_merchant_nested_1' },
      recipient: { id: 'ig_biz_nested_1' },
      timestamp: Date.now(),
      message: { mid: 'mid_referral_nested_1', text: 'Activate', referral: { ref: channel.id } },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => {
      const row = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
      return row?.merchantRecipientId === 'igsid_merchant_nested_1'
    })

    expect(natsPublish).not.toHaveBeenCalled()
  })

  it('recognizes a later message from the same merchant IGSID (no referral field) and updates the timestamp instead of treating it as a new customer', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const channel = await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_2',
      merchantRecipientId: 'igsid_merchant_2',
    })
    const staleTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await db.update(merchantChannels).set({ merchantLastMessageAt: staleTimestamp }).where(eq(merchantChannels.id, channel.id))

    const payload = instagramPayload('ig_biz_2', [{
      sender: { id: 'igsid_merchant_2' },
      recipient: { id: 'ig_biz_2' },
      timestamp: Date.now(),
      message: { mid: 'mid_second_1', text: 'checking in' },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => {
      const row = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
      return (row?.merchantLastMessageAt?.getTime() ?? 0) > staleTimestamp.getTime()
    })

    // Not treated as a customer message — this is the regression: without
    // recognizing the sender as the merchant, this would have published an
    // InboundMessageEvent with customerId = the merchant's own IGSID.
    expect(natsPublish).not.toHaveBeenCalled()
    const refreshed = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
    expect(refreshed?.merchantLastMessageAt?.getTime()).toBeGreaterThan(staleTimestamp.getTime())
  })

  it('still publishes a genuine customer message (different IGSID) normally', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_3',
      merchantRecipientId: 'igsid_merchant_3',
    })

    const payload = instagramPayload('ig_biz_3', [{
      sender: { id: 'igsid_customer_1' },
      recipient: { id: 'ig_biz_3' },
      timestamp: Date.now(),
      message: { mid: 'mid_customer_1', text: 'Do you have this in blue?' },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => natsPublish.mock.calls.length > 0)

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.inbound.message',
      merchantId: merchant.id,
      message: expect.objectContaining({ customerId: 'igsid_customer_1', text: 'Do you have this in blue?' }),
    }))
  })

  it('accepts a webhook signed with the Instagram Login companion app secret, not just the parent Meta app secret', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_4',
      merchantRecipientId: 'igsid_merchant_4',
    })

    const payload = instagramPayload('ig_biz_4', [{
      sender: { id: 'igsid_customer_2' },
      recipient: { id: 'ig_biz_4' },
      timestamp: Date.now(),
      message: { mid: 'mid_customer_2', text: 'Is this still available?' },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signWith('INSTAGRAM_APP_SECRET', body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => natsPublish.mock.calls.length > 0)

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.inbound.message',
      merchantId: merchant.id,
      message: expect.objectContaining({ customerId: 'igsid_customer_2', text: 'Is this still available?' }),
    }))
  })
})

describe('POST /instagram webhook — Mesa\'s own platform account inbox (merchant replies to Mesa)', () => {
  async function seedPlatformAccount(db: ReturnType<typeof getTestDb>, accountId = 'ig_mesa_platform') {
    await db.insert(platformInstagramAccount).values({
      accountId,
      username: 'mesa_hq',
      accessToken: 'mesa_platform_token',
      tokenRefreshedAt: new Date(),
    })
  }

  it('captures the merchant recipient ID from a referral-tagged activation DM landing on the platform inbox, not any merchant\'s own account', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    await seedPlatformAccount(db)
    const merchant = await createMerchant(db)
    const channel = await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_platform_1',
    })

    const payload = instagramPayload('ig_mesa_platform', [{
      sender: { id: 'igsid_merchant_platform_1' },
      recipient: { id: 'ig_mesa_platform' },
      timestamp: Date.now(),
      message: { mid: 'mid_platform_referral_1', text: 'Activate' },
      referral: { ref: channel.id },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => {
      const row = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
      return row?.merchantRecipientId === 'igsid_merchant_platform_1'
    })

    expect(natsPublish).not.toHaveBeenCalled()
  })

  it('captures the merchant recipient ID on the platform inbox when referral is nested under message.referral — F-32 regression: this is Meta\'s actual shape for a brand-new thread, which every real activation DM is; the top-level shape only fires on messaging_referral for an existing thread', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    await seedPlatformAccount(db)
    const merchant = await createMerchant(db)
    const channel = await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_platform_nested_1',
    })

    const payload = instagramPayload('ig_mesa_platform', [{
      sender: { id: 'igsid_merchant_platform_nested_1' },
      recipient: { id: 'ig_mesa_platform' },
      timestamp: Date.now(),
      message: { mid: 'mid_platform_referral_nested_1', text: 'Activate', referral: { ref: channel.id } },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => {
      const row = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
      return row?.merchantRecipientId === 'igsid_merchant_platform_nested_1'
    })

    expect(natsPublish).not.toHaveBeenCalled()
  })

  it('reverse-looks-up a known merchant replying to Mesa (no referral field) and publishes a direction: vendor inbound event', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    await seedPlatformAccount(db)
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_platform_2',
      merchantRecipientId: 'igsid_merchant_platform_2',
    })

    const payload = instagramPayload('ig_mesa_platform', [{
      sender: { id: 'igsid_merchant_platform_2' },
      recipient: { id: 'ig_mesa_platform' },
      timestamp: Date.now(),
      message: { mid: 'mid_platform_reply_1', text: 'ACCEPT' },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => natsPublish.mock.calls.length > 0)

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.inbound.message',
      merchantId: merchant.id,
      message: expect.objectContaining({
        customerId: 'igsid_merchant_platform_2',
        text: 'ACCEPT',
        direction: 'vendor',
      }),
    }))
  })

  it('ignores an unknown sender DMing the platform account — never publishes and never crashes', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    await seedPlatformAccount(db)

    const payload = instagramPayload('ig_mesa_platform', [{
      sender: { id: 'igsid_stranger_1' },
      recipient: { id: 'ig_mesa_platform' },
      timestamp: Date.now(),
      message: { mid: 'mid_platform_stranger_1', text: 'hello?' },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(natsPublish).not.toHaveBeenCalled()
  })
})

describe('POST /instagram webhook — merchant\'s own native replies to customers (message_echoes)', () => {
  it('captures a merchant\'s native reply (foreign/missing app_id) as a direction: vendor event feeding the negotiation ledger', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_echo_1',
      merchantRecipientId: 'igsid_merchant_echo_1',
    })

    const payload = instagramPayload('ig_shop_echo_1', [{
      sender: { id: 'ig_shop_echo_1' },
      recipient: { id: 'igsid_customer_echo_1' },
      timestamp: Date.now(),
      message: { mid: 'mid_echo_native_1', text: 'no wahala, 35k final', is_echo: true },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)

    await waitFor(async () => natsPublish.mock.calls.length > 0)

    expect(natsPublish).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'mesa.inbound.message',
      merchantId: merchant.id,
      message: expect.objectContaining({
        customerId: 'igsid_customer_echo_1',
        text: 'no wahala, 35k final',
        direction: 'vendor',
      }),
    }))
  })

  it('skips an echo whose app_id matches Mesa\'s own app — Mesa already knows what it sent', async () => {
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const app = await buildApp(natsPublish)
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_shop_echo_2',
      merchantRecipientId: 'igsid_merchant_echo_2',
    })

    const payload = instagramPayload('ig_shop_echo_2', [{
      sender: { id: 'ig_shop_echo_2' },
      recipient: { id: 'igsid_customer_echo_2' },
      timestamp: Date.now(),
      message: { mid: 'mid_echo_mesa_1', text: 'Your order is confirmed!', is_echo: true, app_id: config.INSTAGRAM_APP_ID },
    }])
    const body = JSON.stringify(payload)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(natsPublish).not.toHaveBeenCalled()
  })
})
