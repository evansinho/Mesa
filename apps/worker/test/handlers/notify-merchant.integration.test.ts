import { notifyMerchantOnSourceChannel } from '../../src/handlers/notify-merchant'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'

setupIntegration()

function buildNats() {
  return { publish: jest.fn().mockResolvedValue(undefined) }
}

describe('notifyMerchantOnSourceChannel — Instagram window expiry falls back to WhatsApp', () => {
  it('notifies the merchant on Instagram when the 24h window is open', async () => {
    const db = getTestDb()
    const nats = buildNats()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      merchantRecipientId: 'igsid_merchant_1',
      merchantLastMessageAt: new Date(),
      status: 'connected',
    })

    await notifyMerchantOnSourceChannel(db, nats as never, {
      merchantId: merchant.id,
      sourceChannel: 'instagram',
      message: 'New order received',
    })

    expect(nats.publish).toHaveBeenCalledWith(expect.objectContaining({ channel: 'instagram', to: 'igsid_merchant_1' }))
  })

  it('falls back to WhatsApp when the Instagram activation is complete but the 24h window has closed — silent-drop regression', async () => {
    // The exact production case: order detected correctly via Instagram,
    // pending task created correctly, but the merchant hadn't re-DM'd
    // Mesa's platform account in 24h+ (the common case after one-time
    // activation) — this used to commit to Instagram at this layer with no
    // window check, so notification.handler.ts's own window check (at
    // actual send time) had no one left to fall back for.
    const db = getTestDb()
    const nats = buildNats()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      merchantRecipientId: 'igsid_merchant_1',
      merchantLastMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      status: 'connected',
    })

    await notifyMerchantOnSourceChannel(db, nats as never, {
      merchantId: merchant.id,
      sourceChannel: 'instagram',
      message: 'New order received',
    })

    expect(nats.publish).toHaveBeenCalledTimes(1)
    expect(nats.publish).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'whatsapp',
      to: '+2348012345678',
      message: 'New order received',
    }))
  })

  it('falls back to WhatsApp when Instagram was never activated (no merchantRecipientId) — pre-existing behavior', async () => {
    const db = getTestDb()
    const nats = buildNats()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      status: 'connected',
    })

    await notifyMerchantOnSourceChannel(db, nats as never, {
      merchantId: merchant.id,
      sourceChannel: 'instagram',
      message: 'New order received',
    })

    expect(nats.publish).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp', to: '+2348012345678' }))
  })
})
