import { createHmac } from 'crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { merchantChannels } from '@mesa/db'
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
