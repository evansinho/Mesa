import { and, eq } from 'drizzle-orm'
import { domainEvents } from '@mesa/db'
import { EventStore, type OutboxMode } from '../../src/events/event-store'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'

setupIntegration()

describe('EventStore', () => {
  describe('emit — outbox mode wiring', () => {
    function build(mode: OutboxMode, onEnqueued: () => void) {
      const db = getTestDb()
      const natsPublish = jest.fn().mockResolvedValue(undefined)
      const nats = { publish: natsPublish } as never
      return { store: new EventStore(db, nats, mode, onEnqueued), natsPublish }
    }

    it('active mode wakes the publisher instead of publishing directly', async () => {
      const onEnqueued = jest.fn()
      const { store, natsPublish } = build('active', onEnqueued)

      await store.emit({ subject: 'mesa.order.confirmed', orderId: 'o-1', merchantId: 'm-1' })

      expect(natsPublish).not.toHaveBeenCalled()
      expect(onEnqueued).toHaveBeenCalledTimes(1)
    })

    it('off/shadow modes publish directly and never wake the publisher — the outbox row is a log/replay copy, not the delivery path', async () => {
      for (const mode of ['off', 'shadow'] as const) {
        const onEnqueued = jest.fn()
        const { store, natsPublish } = build(mode, onEnqueued)

        await store.emit({ subject: 'mesa.order.confirmed', orderId: 'o-2', merchantId: 'm-1' })

        expect(natsPublish).toHaveBeenCalledTimes(1)
        expect(onEnqueued).not.toHaveBeenCalled()
      }
    })
  })
  it('append inserts a row with the wrapped {v, data} payload', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    const aggregateId = 'agg-1'

    await store.append(aggregateId, 'conversation', 'CUSTOM_EVENT', { hello: 'world' })

    const rows = await db.query.domainEvents.findMany({
      where: eq(domainEvents.aggregateId, aggregateId),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toEqual({ v: 1, data: { hello: 'world' } })
    expect(rows[0].publishedAt).toBeNull()
    expect(rows[0].publishAttempts).toBe(0)
  })

  it('appendOnce for ORDER_CONFIRMED returns true once, false on repeat — F-15 regression', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    const aggregateId = 'order-1'
    const payload = { merchantId: 'm-1', total: 5000 }

    const first = await store.appendOnce(aggregateId, 'order', 'ORDER_CONFIRMED', payload)
    const second = await store.appendOnce(aggregateId, 'order', 'ORDER_CONFIRMED', payload)

    expect(first).toBe(true)
    expect(second).toBe(false)

    const rows = await db.query.domainEvents.findMany({
      where: and(
        eq(domainEvents.aggregateId, aggregateId),
        eq(domainEvents.eventType, 'ORDER_CONFIRMED'),
      ),
    })
    expect(rows).toHaveLength(1)
  })

  it('appendOnce for ORDER_DETECTED inserts repeated detections for the same conversation', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    const aggregateId = 'conv-repeat-order'
    const payload = {
      merchantId: 'm-1',
      conversationId: aggregateId,
      customerPhone: '2348099998888',
      items: [{ productName: 'rice', quantity: 2 }],
      agreedTotal: 150000,
    }

    const first = await store.appendOnce(aggregateId, 'conversation', 'ORDER_DETECTED', payload)
    const second = await store.appendOnce(aggregateId, 'conversation', 'ORDER_DETECTED', {
      ...payload,
      items: [{ productName: 'beans', quantity: 1 }],
      agreedTotal: 50000,
    })

    expect(first).toBe(true)
    expect(second).toBe(true)

    const rows = await db.query.domainEvents.findMany({
      where: and(
        eq(domainEvents.aggregateId, aggregateId),
        eq(domainEvents.eventType, 'ORDER_DETECTED'),
      ),
    })
    expect(rows).toHaveLength(2)
  })

  it('appendOnce for PAYMENT_SCREENSHOT_RECEIVED inserts repeated submissions for the same order — retry-after-failed regression', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    const aggregateId = 'order-payment-retry'
    const payload = { merchantId: 'm-1', screenshotUrl: 'https://r2/first.jpg', screenshotHash: 'hash-1' }

    const first = await store.appendOnce(aggregateId, 'order', 'PAYMENT_SCREENSHOT_RECEIVED', payload)
    const second = await store.appendOnce(aggregateId, 'order', 'PAYMENT_SCREENSHOT_RECEIVED', {
      ...payload,
      screenshotUrl: 'https://r2/retry.jpg',
      screenshotHash: 'hash-2',
    })

    expect(first).toBe(true)
    expect(second).toBe(true)

    const rows = await db.query.domainEvents.findMany({
      where: and(
        eq(domainEvents.aggregateId, aggregateId),
        eq(domainEvents.eventType, 'PAYMENT_SCREENSHOT_RECEIVED'),
      ),
    })
    expect(rows).toHaveLength(2)
  })

  it('appendOnce for STATE_CHANGED always inserts (not in the appendOnce set)', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    const aggregateId = 'conv-1'

    await store.appendOnce(aggregateId, 'conversation', 'STATE_CHANGED', { from: 'IDLE', to: 'BROWSING' })
    await store.appendOnce(aggregateId, 'conversation', 'STATE_CHANGED', { from: 'BROWSING', to: 'NEGOTIATING' })

    const rows = await db.query.domainEvents.findMany({
      where: and(
        eq(domainEvents.aggregateId, aggregateId),
        eq(domainEvents.eventType, 'STATE_CHANGED'),
      ),
    })
    expect(rows).toHaveLength(2)
  })

  it('concurrent appendOnce calls insert exactly one row — F-15 regression (race)', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    const aggregateId = 'order-race'
    const payload = { merchantId: 'm-1', total: 5000 }

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.appendOnce(aggregateId, 'order', 'ORDER_CONFIRMED', payload),
      ),
    )

    const successes = results.filter(r => r).length
    expect(successes).toBe(1)

    const rows = await db.query.domainEvents.findMany({
      where: and(
        eq(domainEvents.aggregateId, aggregateId),
        eq(domainEvents.eventType, 'ORDER_CONFIRMED'),
      ),
    })
    expect(rows).toHaveLength(1)
  })

  it('validate throws when a state-change event is missing merchantId', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    await expect(
      // No merchantId — tenancy is unroutable downstream.
      store.append('order-bad', 'order', 'ORDER_CONFIRMED', { total: 5000 }),
    ).rejects.toThrow(/Invalid payload/)
  })

  it('validate accepts a state-change event with merchantId regardless of other fields', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    await expect(
      store.append('order-ok', 'order', 'ORDER_CONFIRMED', { merchantId: 'm-1' }),
    ).resolves.toBeUndefined()
  })

  it('validate is a no-op for unknown event types', async () => {
    const db = getTestDb()
    const store = new EventStore(db)
    await expect(
      store.append('agg-unknown', 'order', 'SOME_UNREGISTERED_EVENT', { random: true }),
    ).resolves.toBeUndefined()
  })
})
