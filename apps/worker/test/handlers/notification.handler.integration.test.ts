// Replace @mesa/messaging with a recording mock so we can assert routing
// without making real Meta Graph calls.
const sendMock = jest.fn()
jest.mock('@mesa/messaging', () => ({
  send: (...args: unknown[]) => sendMock(...args),
}))

import { eq } from 'drizzle-orm'
import { notificationFailures } from '@mesa/db'
import { NotificationHandler } from '../../src/handlers/notification.handler'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'

setupIntegration()

beforeEach(() => {
  sendMock.mockReset()
  sendMock.mockResolvedValue(undefined)
})

describe('NotificationHandler.handle — WhatsApp routing (F-8)', () => {
  it('sends from Mesa shared number when recipient is the merchant phone', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: '+2348012345678',
      channel: 'whatsapp',
      message: 'Order detected — Reply YES.',
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      'whatsapp',
      '+2348012345678',
      'Order detected — Reply YES.',
      // No per-merchant creds passed → uses Mesa shared
    )
  })

  it('sends from merchant WABA when recipient is a customer and creds are stored — F-8 regression', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'whatsapp',
      channelAccountId: 'pn_merchant_real',
      accessToken: 'tok_merchant_real',
      status: 'connected',
    })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: '+2348099999999', // customer, not merchant
      channel: 'whatsapp',
      message: 'Payment confirmed. Thank you.',
    })

    expect(sendMock).toHaveBeenCalledWith(
      'whatsapp',
      '+2348099999999',
      'Payment confirmed. Thank you.',
      {
        whatsappPhoneNumberId: 'pn_merchant_real',
        whatsappAccessToken: 'tok_merchant_real',
      },
    )
  })

  it('falls back to Mesa shared when merchant has no stored creds — F-8 regression', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'whatsapp',
      channelAccountId: 'pn_some_id',
      accessToken: null, // legacy merchant without stored token
      status: 'connected',
    })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: '+2348099999999',
      channel: 'whatsapp',
      message: 'Hello customer.',
    })

    // 4 args means creds were passed; 3 args means fallback.
    expect(sendMock.mock.calls[0]).toHaveLength(3)
  })

  it('treats pending_* channelAccountId as no creds (dev placeholder) — F-8 regression', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'whatsapp',
      channelAccountId: `pending_${merchant.id.slice(0, 8)}`,
      accessToken: 'tok_anything',
      status: 'connected',
    })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: '+2348099999999',
      channel: 'whatsapp',
      message: 'Hello.',
    })

    // Fallback — 3 args, no per-merchant creds.
    expect(sendMock.mock.calls[0]).toHaveLength(3)
  })

  it('normalizes phone format when matching merchant phone (zero-prefix vs +234)', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    // Recipient provided in local 08… form. Should still be recognized as the merchant.
    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: '08012345678',
      channel: 'whatsapp',
      message: 'Internal merchant message.',
    })

    // 3 args = Mesa shared (merchant-bound).
    expect(sendMock.mock.calls[0]).toHaveLength(3)
  })

  it('suppresses duplicate outbound WhatsApp notifications within the dedupe window', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const handler = new NotificationHandler(db, log, redis)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    const event = {
      subject: 'mesa.notification.send' as const,
      merchantId: merchant.id,
      to: '+2348099999999',
      channel: 'whatsapp' as const,
      message: "I'll ask someone from the store to help with this.",
    }

    await handler.handle(event)
    await handler.handle(event)
    await handler.handle({ ...event, to: '08099999999' })

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate notification suppressed'))
  })
})

describe('NotificationHandler.handle — failure persistence (F-13)', () => {
  it('clears the dedupe lock after a send failure so retry can deliver', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const handler = new NotificationHandler(db, log, redis)
    const merchant = await createMerchant(db, { phone: '+2348011112222' })
    const event = {
      subject: 'mesa.notification.send' as const,
      merchantId: merchant.id,
      to: '+2348011112222',
      channel: 'whatsapp' as const,
      message: 'Retry me.',
    }

    sendMock.mockRejectedValueOnce(new Error('Meta API: 500'))

    await expect(handler.handle(event)).rejects.toThrow(/Meta API/)
    sendMock.mockResolvedValueOnce(undefined)
    await handler.handle(event)

    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('persists a notification_failures row and re-throws on send error — F-13 regression', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348011112222' })

    sendMock.mockRejectedValueOnce(new Error('Meta API: 401 Unauthorized'))

    await expect(
      handler.handle({
        subject: 'mesa.notification.send',
        merchantId: merchant.id,
        to: '+2348011112222',
        channel: 'whatsapp',
        message: 'This will fail.',
      }),
    ).rejects.toThrow(/Meta API/)

    const failures = await db.query.notificationFailures.findMany({
      where: eq(notificationFailures.merchantId, merchant.id),
    })
    expect(failures).toHaveLength(1)
    expect(failures[0].errorMessage).toMatch(/Meta API/)
    expect(failures[0].channel).toBe('whatsapp')
    expect(failures[0].recipient).toBe('+2348011112222')
    expect(failures[0].resolvedAt).toBeNull()
  })

  it('truncates the error message to 1000 chars', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db)

    const longErr = 'x'.repeat(2000)
    sendMock.mockRejectedValueOnce(new Error(longErr))

    await expect(
      handler.handle({
        subject: 'mesa.notification.send',
        merchantId: merchant.id,
        to: merchant.phone,
        channel: 'whatsapp',
        message: 'fail',
      }),
    ).rejects.toThrow()

    const [row] = await db.query.notificationFailures.findMany({
      where: eq(notificationFailures.merchantId, merchant.id),
    })
    expect(row.errorMessage.length).toBeLessThanOrEqual(1000)
  })
})
