import { eq } from 'drizzle-orm'
import { fulfilments, orders } from '@mesa/db'
import { FulfilmentHandler } from '../../src/handlers/fulfilment.handler'
import { PendingDecisions } from '../../src/handlers/pending-decisions'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation } from '@test-helpers/factories'
import * as fez from '../../src/delivery/fez'
import * as kwik from '../../src/delivery/kwik'

jest.mock('../../src/delivery/fez')
jest.mock('../../src/delivery/kwik')

setupIntegration()

const MERCHANT_PHONE = '+2348012345678'
const CUSTOMER_PHONE = '+2348099998888'

function build() {
  const db = getTestDb()
  const redis = getTestRedis()
  const natsPublish = jest.fn().mockResolvedValue(undefined)
  const nats = { publish: natsPublish } as never
  const pending = new PendingDecisions(db, redis)
  const fulfilmentHandler = new FulfilmentHandler(db, nats, pending, redis)
  return { db, redis, natsPublish, pending, fulfilmentHandler }
}

async function seedAddressRequiredFulfilment(db: ReturnType<typeof getTestDb>, opts: {
  merchantId: string
  pickupAddress?: string
}) {
  const conv = await createConversation(db, opts.merchantId, { customerPhone: CUSTOMER_PHONE })
  const [order] = await db.insert(orders).values({
    merchantId: opts.merchantId,
    conversationId: conv.id,
    customerPhone: CUSTOMER_PHONE,
    status: 'PAID',
    subtotal: '20000',
    total: '20000',
  }).returning()
  const [fulfilment] = await db.insert(fulfilments).values({
    merchantId: opts.merchantId,
    orderId: order.id,
    customerPhone: CUSTOMER_PHONE,
    status: 'ADDRESS_REQUIRED',
    mode: 'BOOK_RIDER',
    pickupAddress: opts.pickupAddress ?? '10 Marina Street, Lagos Island, Lagos',
    packageDescription: '1x sneakers',
    packageValue: '20000',
  }).returning()
  return { order, fulfilment }
}

beforeEach(() => {
  jest.mocked(fez.quote).mockReset()
  jest.mocked(fez.createOrder).mockReset()
  jest.mocked(kwik.quote).mockReset()
  jest.mocked(kwik.createTask).mockReset()
})

describe('FulfilmentHandler — delivery provider dispatch (FEZ/Kwik)', () => {
  const originalFlag = process.env.DELIVERY_INTEGRATIONS_ENABLED

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DELIVERY_INTEGRATIONS_ENABLED
    else process.env.DELIVERY_INTEGRATIONS_ENABLED = originalFlag
  })

  it('flag off: falls through to manual dispatch untouched, even with delivery.enabled and a Lagos address', async () => {
    delete process.env.DELIVERY_INTEGRATIONS_ENABLED
    const { db, fulfilmentHandler, natsPublish } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { delivery: { enabled: true } } })
    const { fulfilment } = await seedAddressRequiredFulfilment(db, { merchantId: merchant.id })

    await fulfilmentHandler.handleCustomerAddress(merchant.id, CUSTOMER_PHONE, '5 Adeola Odeku, Victoria Island, Lagos')

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('READY_FOR_DISPATCH')
    expect(fez.quote).not.toHaveBeenCalled()
    expect(kwik.quote).not.toHaveBeenCalled()
    expect(natsPublish.mock.calls.map(c => c[0])).toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/Manual fulfilment MVP/i),
    }))
  })

  it('flag on + delivery.enabled + Lagos-to-Lagos: quotes via Kwik and asks the merchant to confirm instead of dispatching manually', async () => {
    process.env.DELIVERY_INTEGRATIONS_ENABLED = 'true'
    jest.mocked(kwik.quote).mockResolvedValue({
      status: 'quoted',
      feeKobo: 150000,
      providerQuoteId: 'kwik_q_1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const { db, fulfilmentHandler, natsPublish, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { delivery: { enabled: true } } })
    const { fulfilment } = await seedAddressRequiredFulfilment(db, { merchantId: merchant.id })

    await fulfilmentHandler.handleCustomerAddress(merchant.id, CUSTOMER_PHONE, '5 Adeola Odeku, Victoria Island, Lagos')

    expect(kwik.quote).toHaveBeenCalledTimes(1)
    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('QUOTE_PENDING')
    expect(refreshed?.provider).toBe('KWIK')
    expect(refreshed?.providerQuoteId).toBe('kwik_q_1')
    expect(refreshed?.deliveryFeeKobo).toBe(150000)

    const decision = await pending.get(merchant.id, 'PENDING_FULFILMENT_DECISION')
    expect(decision).toEqual(expect.objectContaining({
      quote: expect.objectContaining({ provider: 'KWIK', feeKobo: 150000, providerQuoteId: 'kwik_q_1' }),
    }))
    expect(natsPublish.mock.calls.map(c => c[0])).toContainEqual(expect.objectContaining({
      template: expect.objectContaining({ name: 'mesa_delivery_quote' }),
    }))
    // Manual dispatch must NOT have happened yet — merchant hasn't confirmed.
    expect(natsPublish.mock.calls.map(c => c[0])).not.toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/Manual fulfilment MVP/i),
    }))
  })

  it('flag on + interstate destination: falls back to FEZ, never guessing Kwik', async () => {
    process.env.DELIVERY_INTEGRATIONS_ENABLED = 'true'
    jest.mocked(fez.quote).mockResolvedValue({
      status: 'quoted',
      feeKobo: 250000,
      providerQuoteId: 'fez_q_1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const { db, fulfilmentHandler } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { delivery: { enabled: true } } })
    const { fulfilment } = await seedAddressRequiredFulfilment(db, { merchantId: merchant.id })

    await fulfilmentHandler.handleCustomerAddress(merchant.id, CUSTOMER_PHONE, '4 Aba Road, Port Harcourt, Rivers State')

    expect(fez.quote).toHaveBeenCalledTimes(1)
    expect(kwik.quote).not.toHaveBeenCalled()
    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.provider).toBe('FEZ')
  })

  it('confirm_delivery books via the resolved provider and notifies merchant + customer with the tracking link', async () => {
    process.env.DELIVERY_INTEGRATIONS_ENABLED = 'true'
    jest.mocked(kwik.createTask).mockResolvedValue({
      status: 'booked',
      providerOrderId: 'kwik_order_1',
      trackingUrl: 'https://kwik.test/track/1',
    })
    const { db, fulfilmentHandler, natsPublish, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { delivery: { enabled: true } } })
    const { fulfilment } = await seedAddressRequiredFulfilment(db, { merchantId: merchant.id })
    await db.update(fulfilments).set({
      status: 'QUOTE_PENDING',
      dropoffAddress: '5 Adeola Odeku, Victoria Island, Lagos',
      dropoffState: 'Lagos',
      provider: 'KWIK',
      providerQuoteId: 'kwik_q_1',
      deliveryFeeKobo: 150000,
      quoteExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(fulfilments.id, fulfilment.id))
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: fulfilment.orderId,
      fulfilmentId: fulfilment.id,
      customerPhone: CUSTOMER_PHONE,
      customerChannel: 'whatsapp',
      itemsSummary: '1x sneakers',
      totalPaid: 20000,
      quote: { provider: 'KWIK', feeKobo: 150000, providerQuoteId: 'kwik_q_1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    })

    await fulfilmentHandler.handleMerchantReply(merchant.id, 'confirm_delivery', 'whatsapp')

    expect(kwik.createTask).toHaveBeenCalledTimes(1)
    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('BOOKED')
    expect(refreshed?.providerOrderId).toBe('kwik_order_1')
    expect(refreshed?.trackingUrl).toBe('https://kwik.test/track/1')
    await expect(pending.get(merchant.id, 'PENDING_FULFILMENT_DECISION')).resolves.toBeNull()

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      to: CUSTOMER_PHONE,
      message: expect.stringContaining('https://kwik.test/track/1'),
    }))
  })

  it('decline_delivery falls back to manual dispatch, reusing the already-persisted address and summary', async () => {
    process.env.DELIVERY_INTEGRATIONS_ENABLED = 'true'
    const { db, fulfilmentHandler, natsPublish, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { delivery: { enabled: true } } })
    const { fulfilment } = await seedAddressRequiredFulfilment(db, { merchantId: merchant.id })
    await db.update(fulfilments).set({
      status: 'QUOTE_PENDING',
      dropoffAddress: '5 Adeola Odeku, Victoria Island, Lagos',
      dispatchSummary: 'Dispatch details ready.\n\nSome summary body.',
      provider: 'KWIK',
      providerQuoteId: 'kwik_q_1',
      deliveryFeeKobo: 150000,
      quoteExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(fulfilments.id, fulfilment.id))
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: fulfilment.orderId,
      fulfilmentId: fulfilment.id,
      customerPhone: CUSTOMER_PHONE,
      customerChannel: 'whatsapp',
      itemsSummary: '1x sneakers',
      totalPaid: 20000,
      quote: { provider: 'KWIK', feeKobo: 150000, providerQuoteId: 'kwik_q_1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    })

    await fulfilmentHandler.handleMerchantReply(merchant.id, 'decline_delivery', 'whatsapp')

    expect(kwik.createTask).not.toHaveBeenCalled()
    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('READY_FOR_DISPATCH')
    await expect(pending.get(merchant.id, 'PENDING_FULFILMENT_DECISION')).resolves.toBeNull()

    const messages = natsPublish.mock.calls.map(c => c[0] as { message?: string })
    expect(messages).toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/Manual fulfilment MVP/i),
    }))
  })

  it('an expired quote is silently re-quoted before booking, rather than booking a stale fee', async () => {
    process.env.DELIVERY_INTEGRATIONS_ENABLED = 'true'
    jest.mocked(kwik.quote).mockResolvedValue({
      status: 'quoted',
      feeKobo: 180000,
      providerQuoteId: 'kwik_q_2',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    jest.mocked(kwik.createTask).mockResolvedValue({ status: 'booked', providerOrderId: 'kwik_order_2', trackingUrl: 'https://kwik.test/track/2' })
    const { db, fulfilmentHandler, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { delivery: { enabled: true } } })
    const { fulfilment } = await seedAddressRequiredFulfilment(db, { merchantId: merchant.id })
    await db.update(fulfilments).set({
      status: 'QUOTE_PENDING',
      dropoffAddress: '5 Adeola Odeku, Victoria Island, Lagos',
      dropoffState: 'Lagos',
      provider: 'KWIK',
      providerQuoteId: 'kwik_q_stale',
      deliveryFeeKobo: 100000,
      quoteExpiresAt: new Date(Date.now() - 60_000), // already expired
    }).where(eq(fulfilments.id, fulfilment.id))
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: fulfilment.orderId,
      fulfilmentId: fulfilment.id,
      customerPhone: CUSTOMER_PHONE,
      customerChannel: 'whatsapp',
      itemsSummary: '1x sneakers',
      totalPaid: 20000,
      quote: { provider: 'KWIK', feeKobo: 100000, providerQuoteId: 'kwik_q_stale', expiresAt: new Date(Date.now() - 60_000).toISOString() },
    })

    await fulfilmentHandler.handleMerchantReply(merchant.id, 'confirm_delivery', 'whatsapp')

    expect(kwik.quote).toHaveBeenCalledTimes(1)
    expect(kwik.createTask).toHaveBeenCalledTimes(1)
    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('BOOKED')
    expect(refreshed?.providerOrderId).toBe('kwik_order_2')
  })

  it('a retryable provider outage at booking time enqueues a retry instead of dropping the confirmation', async () => {
    process.env.DELIVERY_INTEGRATIONS_ENABLED = 'true'
    jest.mocked(kwik.createTask).mockResolvedValue({ status: 'retryable' })
    const { db, redis, fulfilmentHandler, pending } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE, config: { delivery: { enabled: true } } })
    const { fulfilment } = await seedAddressRequiredFulfilment(db, { merchantId: merchant.id })
    await db.update(fulfilments).set({
      status: 'QUOTE_PENDING',
      dropoffAddress: '5 Adeola Odeku, Victoria Island, Lagos',
      dropoffState: 'Lagos',
      provider: 'KWIK',
      providerQuoteId: 'kwik_q_3',
      deliveryFeeKobo: 150000,
      quoteExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(fulfilments.id, fulfilment.id))
    await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', {
      orderId: fulfilment.orderId,
      fulfilmentId: fulfilment.id,
      customerPhone: CUSTOMER_PHONE,
      customerChannel: 'whatsapp',
      itemsSummary: '1x sneakers',
      totalPaid: 20000,
      quote: { provider: 'KWIK', feeKobo: 150000, providerQuoteId: 'kwik_q_3', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    })

    await fulfilmentHandler.handleMerchantReply(merchant.id, 'confirm_delivery', 'whatsapp')

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    // Left as QUOTE_PENDING — not booked, not bounced to manual — a retry will pick it up.
    expect(refreshed?.status).toBe('QUOTE_PENDING')
    const due = await redis.zrangebyscore('delivery_booking_retries', 0, '+inf')
    expect(due).toContain(fulfilment.id)

    jest.mocked(kwik.createTask).mockResolvedValue({ status: 'booked', providerOrderId: 'kwik_order_3', trackingUrl: 'https://kwik.test/track/3' })
    await redis.zadd('delivery_booking_retries', 0, fulfilment.id) // force it due now
    await fulfilmentHandler.processBookingRetries()

    const booked = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(booked?.status).toBe('BOOKED')
    expect(booked?.providerOrderId).toBe('kwik_order_3')
  })
})
