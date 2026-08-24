import { eq } from 'drizzle-orm'
import { fulfilments, orders } from '@mesa/db'
import { DeliveryHandler, enqueueKwikPoll } from '../../src/handlers/delivery.handler'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation } from '@test-helpers/factories'
import * as kwik from '../../src/delivery/kwik'

jest.mock('../../src/delivery/kwik')

setupIntegration()

const MERCHANT_PHONE = '+2348012345678'
const CUSTOMER_PHONE = '+2348099998888'

function build() {
  const db = getTestDb()
  const redis = getTestRedis()
  const natsPublish = jest.fn().mockResolvedValue(undefined)
  const nats = { publish: natsPublish } as never
  const deliveryHandler = new DeliveryHandler(db, nats, redis)
  return { db, redis, natsPublish, deliveryHandler }
}

async function seedBookedKwikFulfilment(db: ReturnType<typeof getTestDb>, opts: { channel?: 'whatsapp' | 'instagram' } = {}) {
  const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
  const conv = await createConversation(db, merchant.id, { channel: opts.channel ?? 'whatsapp', customerPhone: CUSTOMER_PHONE })
  const [order] = await db.insert(orders).values({
    merchantId: merchant.id,
    conversationId: conv.id,
    customerPhone: CUSTOMER_PHONE,
    status: 'PAID',
    subtotal: '20000',
    total: '20000',
  }).returning()
  const [fulfilment] = await db.insert(fulfilments).values({
    merchantId: merchant.id,
    orderId: order.id,
    customerPhone: CUSTOMER_PHONE,
    status: 'BOOKED',
    mode: 'BOOK_RIDER',
    provider: 'KWIK',
    providerOrderId: 'kwik_order_1',
  }).returning()
  return { merchant, order, fulfilment }
}

beforeEach(() => {
  jest.mocked(kwik.getStatus).mockReset()
})

describe('DeliveryHandler — Kwik polling', () => {
  it('does nothing when no polls are due', async () => {
    const { deliveryHandler } = build()
    await deliveryHandler.processKwikPolls()
    expect(kwik.getStatus).not.toHaveBeenCalled()
  })

  it('an in-progress status updates providerStatus/IN_TRANSIT and re-enqueues for another poll', async () => {
    jest.mocked(kwik.getStatus).mockResolvedValue({ status: 'in_transit', raw: 'in-progress' })
    const { db, redis, deliveryHandler } = build()
    const { fulfilment } = await seedBookedKwikFulfilment(db)
    await enqueueKwikPoll(redis, fulfilment.id)
    await redis.zadd('kwik_polls', 0, fulfilment.id) // force due now

    await deliveryHandler.processKwikPolls()

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('IN_TRANSIT')
    expect(refreshed?.providerStatus).toBe('in-progress')
    const stillTracked = await redis.zscore('kwik_polls', fulfilment.id)
    expect(stillTracked).not.toBeNull() // re-enqueued since not terminal
  })

  it('a terminal delivered status stops polling — does not re-enqueue', async () => {
    jest.mocked(kwik.getStatus).mockResolvedValue({ status: 'delivered', raw: 'completed' })
    const { db, redis, deliveryHandler } = build()
    const { fulfilment } = await seedBookedKwikFulfilment(db)
    await enqueueKwikPoll(redis, fulfilment.id)
    await redis.zadd('kwik_polls', 0, fulfilment.id)

    await deliveryHandler.processKwikPolls()

    const refreshed = await db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilment.id) })
    expect(refreshed?.status).toBe('DELIVERED')
    const stillTracked = await redis.zscore('kwik_polls', fulfilment.id)
    expect(stillTracked).toBeNull()
  })

  it('skips a fulfilment that already reached a terminal status, without calling Kwik at all', async () => {
    const { db, redis, deliveryHandler } = build()
    const { fulfilment } = await seedBookedKwikFulfilment(db)
    await db.update(fulfilments).set({ status: 'CANCELLED' }).where(eq(fulfilments.id, fulfilment.id))
    await redis.set(`kwik_poll:${fulfilment.id}`, JSON.stringify({ fulfilmentId: fulfilment.id, attempt: 1 }), 'EX', 3600)
    await redis.zadd('kwik_polls', 0, fulfilment.id)

    await deliveryHandler.processKwikPolls()

    expect(kwik.getStatus).not.toHaveBeenCalled()
  })
})

describe('DeliveryHandler — delivery status notifications', () => {
  it('notifies merchant and customer once when providerStatus changes to in_transit, then is a no-op on the next tick', async () => {
    const { db, natsPublish, deliveryHandler } = build()
    const { fulfilment } = await seedBookedKwikFulfilment(db)
    await db.update(fulfilments).set({ status: 'IN_TRANSIT', providerStatus: 'in-progress' }).where(eq(fulfilments.id, fulfilment.id))

    await deliveryHandler.processDeliveryStatusNotifications()

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({ to: MERCHANT_PHONE, message: expect.stringMatching(/on the way/i) }))
    expect(messages).toContainEqual(expect.objectContaining({ to: CUSTOMER_PHONE, message: expect.stringMatching(/on the way/i) }))

    natsPublish.mockClear()
    await deliveryHandler.processDeliveryStatusNotifications()
    expect(natsPublish).not.toHaveBeenCalled()
  })

  it('a cancelled booking notifies only the merchant, not the customer', async () => {
    const { db, natsPublish, deliveryHandler } = build()
    const { fulfilment } = await seedBookedKwikFulfilment(db)
    await db.update(fulfilments).set({ status: 'CANCELLED', providerStatus: 'cancelled' }).where(eq(fulfilments.id, fulfilment.id))

    await deliveryHandler.processDeliveryStatusNotifications()

    const messages = natsPublish.mock.calls.map(c => c[0] as { to?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({ to: MERCHANT_PHONE }))
    expect(messages).not.toContainEqual(expect.objectContaining({ to: CUSTOMER_PHONE }))
  })

  it('routes the merchant notification to Instagram when that is the order source channel', async () => {
    const { db, natsPublish, deliveryHandler } = build()
    const { fulfilment } = await seedBookedKwikFulfilment(db, { channel: 'instagram' })
    await db.update(fulfilments).set({ status: 'DELIVERED', providerStatus: 'completed' }).where(eq(fulfilments.id, fulfilment.id))

    await deliveryHandler.processDeliveryStatusNotifications()

    const messages = natsPublish.mock.calls.map(c => c[0] as { channel?: string; message?: string })
    expect(messages).toContainEqual(expect.objectContaining({ channel: 'instagram' }))
  })

  it('a fulfilment with no provider set is ignored entirely', async () => {
    const { db, natsPublish, deliveryHandler } = build()
    const merchant = await createMerchant(db, { phone: MERCHANT_PHONE })
    const conv = await createConversation(db, merchant.id, { customerPhone: CUSTOMER_PHONE })
    const [order] = await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: conv.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'PAID',
      subtotal: '20000',
      total: '20000',
    }).returning()
    await db.insert(fulfilments).values({
      merchantId: merchant.id,
      orderId: order.id,
      customerPhone: CUSTOMER_PHONE,
      status: 'READY_FOR_DISPATCH',
      mode: 'SELF_DELIVER',
    })

    await deliveryHandler.processDeliveryStatusNotifications()

    expect(natsPublish).not.toHaveBeenCalled()
  })
})
