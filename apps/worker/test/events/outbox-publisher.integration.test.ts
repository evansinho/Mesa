import { eq, isNotNull, isNull } from 'drizzle-orm'
import { domainEvents } from '@mesa/db'
import { OutboxPublisher } from '../../src/events/outbox-publisher'
import { EventStore } from '../../src/events/event-store'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createOrder, createConversation } from '@test-helpers/factories'

setupIntegration()

// Reach into the publisher's private `tick` for direct invocation. We do NOT
// rely on the scheduled timer here — that would be slow and racy. Calling tick
// directly via brackets is the test seam.
function tick(publisher: OutboxPublisher): Promise<void> {
  return (publisher as unknown as { tick: () => Promise<void> }).tick()
}

describe('OutboxPublisher (F-6 integration)', () => {
  it('OFF mode: start() does not schedule a tick', () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const nats = { publish: natsPublish } as never

    const publisher = new OutboxPublisher(db, nats, redis, 'off')
    publisher.start()

    // Nothing scheduled — verified by introspection.
    const timer = (publisher as unknown as { timer: NodeJS.Timeout | null }).timer
    expect(timer).toBeNull()
  })

  it('wake() resets an idle-backed-off interval and reschedules for an immediate tick', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const nats = { publish: jest.fn().mockResolvedValue(undefined) } as never
    const publisher = new OutboxPublisher(db, nats, redis, 'active')
    publisher.start()

    // Simulate the adaptive backoff having climbed toward the 5-minute idle
    // ceiling — this is exactly the gap that made a just-enqueued event
    // (e.g. ORDER_CONFIRMED) wait out a long idle interval before the
    // publisher even looked for it.
    const state = publisher as unknown as { currentInterval: number; timer: NodeJS.Timeout | null }
    state.currentInterval = 300_000

    publisher.wake()

    expect(state.currentInterval).toBe(5_000)
    expect(state.timer).not.toBeNull()

    await publisher.stop()
  })

  it('wake() is a no-op in OFF mode', () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const nats = { publish: jest.fn() } as never
    const publisher = new OutboxPublisher(db, nats, redis, 'off')
    publisher.start()

    expect(() => publisher.wake()).not.toThrow()
    const timer = (publisher as unknown as { timer: NodeJS.Timeout | null }).timer
    expect(timer).toBeNull()
  })

  it('SHADOW mode: logs but does not publish and does not mark published_at — F-6 regression', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const nats = { publish: natsPublish } as never
    const store = new EventStore(db)

    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    await store.appendOnce(order.id, 'order', 'ORDER_CONFIRMED', { merchantId: merchant.id, total: 5000 })

    const publisher = new OutboxPublisher(db, nats, redis, 'shadow')
    await tick(publisher)

    expect(natsPublish).not.toHaveBeenCalled()

    const stillUnpublished = await db.query.domainEvents.findMany({
      where: isNull(domainEvents.publishedAt),
    })
    expect(stillUnpublished).toHaveLength(1)
  })

  it('ACTIVE mode: publishes via NATS and marks published_at — F-6 regression', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const nats = { publish: natsPublish } as never
    const store = new EventStore(db)

    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    await store.appendOnce(order.id, 'order', 'PAYMENT_CONFIRMED', { merchantId: merchant.id, amount: 5000 })

    const publisher = new OutboxPublisher(db, nats, redis, 'active')
    await tick(publisher)

    expect(natsPublish).toHaveBeenCalledTimes(1)
    const event = natsPublish.mock.calls[0][0] as { subject: string; orderId: string; merchantId: string }
    expect(event.subject).toBe('mesa.payment.confirmed')
    expect(event.orderId).toBe(order.id) // reconstructed from aggregate_id
    expect(event.merchantId).toBe(merchant.id)

    const published = await db.query.domainEvents.findMany({
      where: isNotNull(domainEvents.publishedAt),
    })
    expect(published).toHaveLength(1)
  })

  it('marks unmapped event types (like STATE_CHANGED) as published in either non-off mode', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const nats = { publish: natsPublish } as never
    const store = new EventStore(db)

    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id)
    await store.append(conv.id, 'conversation', 'STATE_CHANGED', { from: 'IDLE', to: 'BROWSING' })

    const publisher = new OutboxPublisher(db, nats, redis, 'shadow')
    await tick(publisher)

    expect(natsPublish).not.toHaveBeenCalled()
    const published = await db.query.domainEvents.findMany({
      where: isNotNull(domainEvents.publishedAt),
    })
    expect(published).toHaveLength(1) // marked even in shadow — no NATS subject anyway
  })

  it('increments publish_attempts and stores last_publish_error on NATS failure — F-6 regression', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const natsPublish = jest.fn().mockRejectedValue(new Error('NATS unreachable'))
    const nats = { publish: natsPublish } as never
    const store = new EventStore(db)

    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    await store.appendOnce(order.id, 'order', 'PAYMENT_CONFIRMED', { merchantId: merchant.id, amount: 5000 })

    const publisher = new OutboxPublisher(db, nats, redis, 'active')
    await tick(publisher)

    const [row] = await db.query.domainEvents.findMany({
      where: eq(domainEvents.aggregateId, order.id),
    })
    expect(row.publishedAt).toBeNull()
    expect(row.publishAttempts).toBe(1)
    expect(row.lastPublishError).toMatch(/NATS unreachable/)
  })

  it('Redis lock prevents concurrent tick execution', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const nats = { publish: natsPublish } as never
    const store = new EventStore(db)

    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    await store.appendOnce(order.id, 'order', 'PAYMENT_CONFIRMED', { merchantId: merchant.id, amount: 5000 })

    // Pre-acquire the lock externally — simulating another replica holding it.
    await redis.set('outbox:publisher:lock', '1', 'EX', 60, 'NX')

    const publisher = new OutboxPublisher(db, nats, redis, 'active')
    await tick(publisher)

    // No publish happened — lock blocked the tick.
    expect(natsPublish).not.toHaveBeenCalled()
    const stillUnpublished = await db.query.domainEvents.findMany({
      where: isNull(domainEvents.publishedAt),
    })
    expect(stillUnpublished).toHaveLength(1)
  })

  it('processes rows in chronological order', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const natsPublish = jest.fn().mockResolvedValue(undefined)
    const nats = { publish: natsPublish } as never
    const store = new EventStore(db)

    const merchant = await createMerchant(db)
    const o1 = await createOrder(db, merchant.id)
    const o2 = await createOrder(db, merchant.id)

    await store.appendOnce(o1.id, 'order', 'PAYMENT_CONFIRMED', { merchantId: merchant.id, amount: 1000 })
    // Tiny delay so o2's event has a later created_at.
    await new Promise(resolve => setTimeout(resolve, 10))
    await store.appendOnce(o2.id, 'order', 'PAYMENT_CONFIRMED', { merchantId: merchant.id, amount: 2000 })

    const publisher = new OutboxPublisher(db, nats, redis, 'active')
    await tick(publisher)

    expect(natsPublish).toHaveBeenCalledTimes(2)
    const firstEvent = natsPublish.mock.calls[0][0] as { orderId: string }
    const secondEvent = natsPublish.mock.calls[1][0] as { orderId: string }
    expect(firstEvent.orderId).toBe(o1.id)
    expect(secondEvent.orderId).toBe(o2.id)
  })
})