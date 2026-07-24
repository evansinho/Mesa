// Replace @mesa/messaging with a recording mock so we can assert routing
// without making real Meta Graph calls.
const sendMock = jest.fn()
jest.mock('@mesa/messaging', () => ({
  send: (...args: unknown[]) => sendMock(...args),
}))

const sendTemplateMock = jest.fn()
const sendTextMock = jest.fn()
jest.mock('@mesa/whatsapp', () => {
  const actual = jest.requireActual('@mesa/whatsapp')
  return {
    ...actual,
    sendTemplate: (...args: unknown[]) => sendTemplateMock(...args),
    sendText: (...args: unknown[]) => sendTextMock(...args),
  }
})

import { eq } from 'drizzle-orm'
import { notificationFailures } from '@mesa/db'
import { NotificationHandler } from '../../src/handlers/notification.handler'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel, createConversation } from '@test-helpers/factories'

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

describe('NotificationHandler.handle — Instagram routing', () => {
  it('sends via the merchant Page credentials stored on merchantChannels, forwarding mediaUrl', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      pageId: 'page_123',
      accessToken: 'page_token_123',
      merchantRecipientId: 'igsid_merchant_1',
      merchantLastMessageAt: new Date(),
    })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: 'igsid_merchant_1',
      channel: 'instagram',
      message: 'New order received',
      mediaUrl: 'https://cdn.instagram.test/product.jpg',
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      'instagram',
      'igsid_merchant_1',
      'New order received',
      { pageId: 'page_123', pageAccessToken: 'page_token_123', mediaUrl: 'https://cdn.instagram.test/product.jpg' },
    )
  })

  it('throws when the merchant has no stored Instagram Page credentials', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    await expect(handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: 'igsid_merchant_1',
      channel: 'instagram',
      message: 'New order received',
    })).rejects.toThrow('Instagram page credentials not configured')

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('treats a disconnected Instagram channel as having no usable credentials', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      pageId: 'page_123',
      accessToken: 'page_token_123',
      merchantRecipientId: 'igsid_merchant_1',
      status: 'disconnected',
    })

    await expect(handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: 'igsid_merchant_1',
      channel: 'instagram',
      message: 'New order received',
    })).rejects.toThrow('Instagram page credentials not configured')

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends a customer-facing Instagram reply when inside the 24h messaging window', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      pageId: 'page_123',
      accessToken: 'page_token_123',
      merchantRecipientId: 'igsid_merchant_1',
    })
    await createConversation(db, merchant.id, {
      channel: 'instagram',
      customerPhone: 'igsid_customer_1',
      context: {
        currentItems: [],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: 'igsid_customer_1',
      channel: 'instagram',
      message: 'Checking it now.',
    })

    expect(sendMock).toHaveBeenCalledWith('instagram', 'igsid_customer_1', 'Checking it now.', expect.anything())
  })

  it('blocks a customer-facing Instagram send outside the 24h messaging window instead of retrying forever', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      pageId: 'page_123',
      accessToken: 'page_token_123',
      merchantRecipientId: 'igsid_merchant_1',
    })
    await createConversation(db, merchant.id, {
      channel: 'instagram',
      customerPhone: 'igsid_customer_1',
      context: {
        currentItems: [],
        negotiationHistory: [],
        lastMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      },
    })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: 'igsid_customer_1',
      channel: 'instagram',
      message: 'Checking it now.',
    })

    expect(sendMock).not.toHaveBeenCalled()
    const failures = await db.query.notificationFailures.findMany({
      where: eq(notificationFailures.merchantId, merchant.id),
    })
    expect(failures).toHaveLength(1)
    expect(failures[0].errorMessage).toContain('24h messaging window')
  })

  it('sends a merchant-facing Instagram notification when inside the 24h window since the merchant last messaged Mesa', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      pageId: 'page_123',
      accessToken: 'page_token_123',
      merchantRecipientId: 'igsid_merchant_1',
      merchantLastMessageAt: new Date(),
    })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: 'igsid_merchant_1',
      channel: 'instagram',
      message: 'New order received',
    })

    expect(sendMock).toHaveBeenCalledWith('instagram', 'igsid_merchant_1', 'New order received', expect.anything())
  })

  it('blocks a merchant-facing Instagram notification once 24h have passed since the merchant last messaged Mesa', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      pageId: 'page_123',
      accessToken: 'page_token_123',
      merchantRecipientId: 'igsid_merchant_1',
      merchantLastMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: 'igsid_merchant_1',
      channel: 'instagram',
      message: 'New order received',
    })

    expect(sendMock).not.toHaveBeenCalled()
    const failures = await db.query.notificationFailures.findMany({
      where: eq(notificationFailures.merchantId, merchant.id),
    })
    expect(failures).toHaveLength(1)
    expect(failures[0].errorMessage).toContain('merchant\'s last message')
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


describe('NotificationHandler — plain-text fallback when template missing on WABA', () => {
  beforeEach(() => {
    sendTemplateMock.mockReset()
    sendTextMock.mockReset()
  })

  it('delivers the order tap as text when the template does not exist yet', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    sendTemplateMock.mockRejectedValueOnce(new Error(
      'WhatsApp sendTemplate failed: 404 {"error":{"code":132001,"message":"Template name does not exist in the translation"}}',
    ))
    sendTextMock.mockResolvedValueOnce({ messages: [{ id: 'wamid.x' }] })

    await handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: '+2348012345678',
      channel: 'whatsapp',
      message: '',
      template: {
        name: 'mesa_new_order_v2',
        languageCode: 'en',
        bodyParams: ['John Doe', '1x Jogger Pants — ₦25,000', '₦25,000'],
        buttons: [],
      },
    })

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const [to, body] = sendTextMock.mock.calls[0]
    expect(to).toBe('+2348012345678')
    expect(body).toContain('New order received')
    expect(body).toContain('John Doe')
    expect(body).toContain('ACCEPT')
  })

  it('still throws (and persists failure) for non-template errors', async () => {
    const db = getTestDb()
    const handler = new NotificationHandler(db)
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    sendTemplateMock.mockRejectedValueOnce(new Error('WhatsApp sendTemplate failed: 500 internal'))

    await expect(handler.handle({
      subject: 'mesa.notification.send',
      merchantId: merchant.id,
      to: '+2348012345678',
      channel: 'whatsapp',
      message: '',
      template: { name: 'mesa_new_order_v2', languageCode: 'en', bodyParams: ['a', 'b', 'c'], buttons: [] },
    })).rejects.toThrow('500 internal')
    expect(sendTextMock).not.toHaveBeenCalled()
  })
})
