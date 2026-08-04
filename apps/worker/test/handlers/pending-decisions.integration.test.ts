import { and, eq } from 'drizzle-orm'
import { agentTasks } from '@mesa/db'
import { PendingDecisions } from '../../src/handlers/pending-decisions'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant } from '@test-helpers/factories'

setupIntegration()

const orderPayload = {
  conversationId: 'conv-1',
  customerPhone: '+2348012345678',
  items: [{ productName: 'rice', quantity: 3 }],
  agreedTotal: 5000,
  prompt: 'Order detected — 3x rice. Reply YES.',
}

describe('PendingDecisions (F-4 integration)', () => {
  it('upsert creates an OPEN agent_tasks row + Redis cache entry', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const pending = new PendingDecisions(db, redis)
    const merchant = await createMerchant(db)

    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', orderPayload)

    const rows = await db.query.agentTasks.findMany({
      where: and(
        eq(agentTasks.merchantId, merchant.id),
        eq(agentTasks.type, 'PENDING_ORDER_CONFIRMATION'),
        eq(agentTasks.status, 'OPEN'),
      ),
    })
    expect(rows).toHaveLength(1)

    const cached = await redis.get(`pending_order_by_merchant:${merchant.id}`)
    expect(cached).not.toBeNull()
    const parsed = JSON.parse(cached!)
    expect(parsed.conversationId).toBe('conv-1')
    expect(parsed.agreedTotal).toBe(5000)
  })

  it('upsert twice keeps a single OPEN row (partial unique index)', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const pending = new PendingDecisions(db, redis)
    const merchant = await createMerchant(db)

    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', orderPayload)
    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', { ...orderPayload, agreedTotal: 7500 })

    const rows = await db.query.agentTasks.findMany({
      where: and(
        eq(agentTasks.merchantId, merchant.id),
        eq(agentTasks.type, 'PENDING_ORDER_CONFIRMATION'),
        eq(agentTasks.status, 'OPEN'),
      ),
    })
    expect(rows).toHaveLength(1)
    expect((rows[0].payload as { agreedTotal: number }).agreedTotal).toBe(7500)
  })

  it('get falls back to DB and rehydrates Redis on cache miss — F-4 regression', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const pending = new PendingDecisions(db, redis)
    const merchant = await createMerchant(db)

    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', orderPayload)
    // Wipe cache, leaving only the DB row.
    await redis.del(`pending_order_by_merchant:${merchant.id}`)

    const fetched = await pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(fetched).not.toBeNull()
    expect((fetched as { conversationId: string }).conversationId).toBe('conv-1')

    // Cache should be rehydrated.
    const cached = await redis.get(`pending_order_by_merchant:${merchant.id}`)
    expect(cached).not.toBeNull()
  })

  it('get returns null when no OPEN row exists', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const pending = new PendingDecisions(db, redis)
    const merchant = await createMerchant(db)

    const fetched = await pending.get(merchant.id, 'PENDING_ORDER_CONFIRMATION')
    expect(fetched).toBeNull()
  })

  it('resolve(DONE) flips status and clears Redis', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const pending = new PendingDecisions(db, redis)
    const merchant = await createMerchant(db)

    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', orderPayload)
    await pending.resolve(merchant.id, 'PENDING_ORDER_CONFIRMATION', 'DONE')

    const openRows = await db.query.agentTasks.findMany({
      where: and(
        eq(agentTasks.merchantId, merchant.id),
        eq(agentTasks.type, 'PENDING_ORDER_CONFIRMATION'),
        eq(agentTasks.status, 'OPEN'),
      ),
    })
    expect(openRows).toHaveLength(0)

    const doneRows = await db.query.agentTasks.findMany({
      where: and(
        eq(agentTasks.merchantId, merchant.id),
        eq(agentTasks.type, 'PENDING_ORDER_CONFIRMATION'),
        eq(agentTasks.status, 'DONE'),
      ),
    })
    expect(doneRows).toHaveLength(1)

    const cached = await redis.get(`pending_order_by_merchant:${merchant.id}`)
    expect(cached).toBeNull()
  })

  it('resolve on a non-existent decision is a no-op that reports nothing was claimed', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const pending = new PendingDecisions(db, redis)
    const merchant = await createMerchant(db)

    await expect(
      pending.resolve(merchant.id, 'PENDING_ORDER_CONFIRMATION', 'DONE'),
    ).resolves.toEqual({ claimed: false, promoted: null })
  })

  it('concurrent upserts on (merchant, type) settle to a single OPEN row', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const pending = new PendingDecisions(db, redis)
    const merchant = await createMerchant(db)

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', {
          ...orderPayload,
          agreedTotal: 1000 + i,
        }),
      ),
    )

    const rows = await db.query.agentTasks.findMany({
      where: and(
        eq(agentTasks.merchantId, merchant.id),
        eq(agentTasks.type, 'PENDING_ORDER_CONFIRMATION'),
        eq(agentTasks.status, 'OPEN'),
      ),
    })
    expect(rows).toHaveLength(1)
  })

  it('PENDING_PAYMENT_REVIEW and PENDING_ORDER_CONFIRMATION coexist for the same merchant', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const pending = new PendingDecisions(db, redis)
    const merchant = await createMerchant(db)

    await pending.upsert(merchant.id, 'PENDING_ORDER_CONFIRMATION', orderPayload)
    await pending.upsert(merchant.id, 'PENDING_PAYMENT_REVIEW', {
      orderId: 'order-1',
      reason: 'low_confidence',
    })

    const allOpen = await db.query.agentTasks.findMany({
      where: and(eq(agentTasks.merchantId, merchant.id), eq(agentTasks.status, 'OPEN')),
    })
    expect(allOpen).toHaveLength(2)
  })

  describe('queueing — concurrent-customer regression', () => {
    const fulfilmentPayload = (orderId: string) => ({
      orderId,
      fulfilmentId: `fulfilment-${orderId}`,
      customerPhone: '+2348012340000',
      customerChannel: 'whatsapp',
      itemsSummary: '1x rice',
      totalPaid: 5000,
    })

    it('a second upsert for a different identity queues silently instead of overwriting the first', async () => {
      const db = getTestDb()
      const redis = getTestRedis()
      const pending = new PendingDecisions(db, redis)
      const merchant = await createMerchant(db)

      const first = await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', fulfilmentPayload('order-A'))
      expect(first.surfaced).toBe(true)

      const second = await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', fulfilmentPayload('order-B'))
      expect(second.surfaced).toBe(false)

      // Both rows exist — B's payload was never lost.
      const allOpen = await db.query.agentTasks.findMany({
        where: and(
          eq(agentTasks.merchantId, merchant.id),
          eq(agentTasks.type, 'PENDING_FULFILMENT_DECISION'),
          eq(agentTasks.status, 'OPEN'),
        ),
      })
      expect(allOpen).toHaveLength(2)

      // get() only ever returns the surfaced one — a merchant's bare reply
      // must never resolve against the queued item it hasn't seen yet.
      const surfaced = await pending.get<{ orderId: string }>(merchant.id, 'PENDING_FULFILMENT_DECISION')
      expect(surfaced?.orderId).toBe('order-A')
    })

    it('resolving the surfaced item promotes the oldest queued one, with its own correct payload', async () => {
      const db = getTestDb()
      const redis = getTestRedis()
      const pending = new PendingDecisions(db, redis)
      const merchant = await createMerchant(db)

      await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', fulfilmentPayload('order-A'))
      await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', fulfilmentPayload('order-B'))

      const { claimed, promoted } = await pending.resolve(merchant.id, 'PENDING_FULFILMENT_DECISION', 'DONE')
      expect(claimed).toBe(true)
      expect((promoted as { orderId: string } | null)?.orderId).toBe('order-B')

      // B is now the surfaced one.
      const surfaced = await pending.get<{ orderId: string }>(merchant.id, 'PENDING_FULFILMENT_DECISION')
      expect(surfaced?.orderId).toBe('order-B')

      // A bare reply resolving again only ever affects the now-current item
      // (B) — resolving a third time correctly reports nothing left.
      const secondResolve = await pending.resolve(merchant.id, 'PENDING_FULFILMENT_DECISION', 'DONE')
      expect(secondResolve.claimed).toBe(true)
      expect(secondResolve.promoted).toBeNull()
    })

    it('resolving before anything is queued reports no promotion', async () => {
      const db = getTestDb()
      const redis = getTestRedis()
      const pending = new PendingDecisions(db, redis)
      const merchant = await createMerchant(db)

      await pending.upsert(merchant.id, 'PENDING_FULFILMENT_DECISION', fulfilmentPayload('order-A'))
      const { claimed, promoted } = await pending.resolve(merchant.id, 'PENDING_FULFILMENT_DECISION', 'DONE')
      expect(claimed).toBe(true)
      expect(promoted).toBeNull()
    })

    it('updateById attaches a patch to a still-queued item, invisible to update()', async () => {
      const db = getTestDb()
      const redis = getTestRedis()
      const pending = new PendingDecisions(db, redis)
      const merchant = await createMerchant(db)

      await pending.upsert(merchant.id, 'PENDING_PAYMENT_REVIEW', { orderId: 'order-A', reason: 'low_confidence' })
      const queued = await pending.upsert(merchant.id, 'PENDING_PAYMENT_REVIEW', { orderId: 'order-B', reason: 'low_confidence' })
      expect(queued.surfaced).toBe(false)

      // update() only ever touches the current surfaced row (order-A) — it
      // must not silently patch the queued one.
      await pending.update(merchant.id, 'PENDING_PAYMENT_REVIEW', { actionToken: 'token-for-A' })
      const rowB = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, queued.id) })
      expect((rowB?.payload as { actionToken?: string }).actionToken).toBeUndefined()

      // updateById targets the exact queued row regardless of surfaced state.
      const patched = await pending.updateById<{ orderId: string; actionToken?: string }>(queued.id, { actionToken: 'token-for-B' })
      expect(patched?.actionToken).toBe('token-for-B')
      const rowBAfter = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, queued.id) })
      expect((rowBAfter?.payload as { actionToken?: string }).actionToken).toBe('token-for-B')
    })
  })
})