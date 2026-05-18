import { eq } from 'drizzle-orm'
import { conversations, domainEvents } from '@mesa/db'
import { ConversationStateMachine } from '../../src/conversation/state-machine'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation } from '@test-helpers/factories'

setupIntegration()

describe('ConversationStateMachine (F-1 integration)', () => {
  it('reads state from DB when Redis is empty — the F-1 regression', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const sm = new ConversationStateMachine(redis, db)

    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, {
      state: 'AWAITING_PAYMENT',
      customerPhone: '+2348012345678',
      context: {
        currentItems: [{ productName: 'rice', quantity: 3 }],
        negotiationHistory: [],
        orderId: 'order-123',
        lastMessageAt: new Date().toISOString(),
      },
    })

    // Redis is empty (the setupIntegration hook flushed it).
    // Before F-1 the next getOrCreate would return a fresh IDLE record,
    // dropping the AWAITING_PAYMENT state and the orderId.
    const record = await sm.getOrCreate(merchant.id, 'whatsapp', '+2348012345678', conv.id)

    expect(record.state).toBe('AWAITING_PAYMENT')
    expect(record.context.orderId).toBe('order-123')
    expect(record.context.currentItems).toHaveLength(1)
  })

  it('rehydrates Redis from DB on cache miss', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const sm = new ConversationStateMachine(redis, db)

    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, {
      state: 'NEGOTIATING',
      customerPhone: '+2348011111111',
    })

    await sm.getOrCreate(merchant.id, 'whatsapp', '+2348011111111', conv.id)

    // Now Redis should have the record cached.
    const cached = await redis.get(`conversation:${merchant.id}:whatsapp:+2348011111111`)
    expect(cached).not.toBeNull()
    expect(JSON.parse(cached!).state).toBe('NEGOTIATING')
  })

  it('persists state + context to DB on transition (not just domain_events)', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const sm = new ConversationStateMachine(redis, db)

    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, { state: 'IDLE' })

    const record = await sm.getOrCreate(merchant.id, 'whatsapp', conv.customerPhone, conv.id)
    await sm.transition(record, 'BROWSING')

    // DB row reflects the new state.
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    expect(row?.state).toBe('BROWSING')

    // STATE_CHANGED audit row is also written.
    const events = await db.query.domainEvents.findMany({
      where: eq(domainEvents.aggregateId, conv.id),
    })
    expect(events.length).toBeGreaterThan(0)
    expect(events.some(e => e.eventType === 'STATE_CHANGED')).toBe(true)
  })

  it('throws on invalid transition without persisting anything', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const sm = new ConversationStateMachine(redis, db)

    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, { state: 'IDLE' })
    const record = await sm.getOrCreate(merchant.id, 'whatsapp', conv.customerPhone, conv.id)

    await expect(sm.transition(record, 'AGREED' /* invalid from IDLE */)).rejects.toThrow(/Invalid transition/)

    // DB still shows IDLE — no partial state.
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, conv.id),
    })
    expect(row?.state).toBe('IDLE')
  })

  it('appendMessage caps the recent-messages buffer at maxRecent', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const sm = new ConversationStateMachine(redis, db)

    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id)
    let record = await sm.getOrCreate(merchant.id, 'whatsapp', conv.customerPhone, conv.id)

    for (let i = 0; i < 15; i++) {
      record = await sm.appendMessage(record, 'customer', `message ${i}`, 10)
    }

    expect(record.context.recentMessages).toHaveLength(10)
    expect(record.context.recentMessages?.[0].text).toBe('message 5')
    expect(record.context.recentMessages?.[9].text).toBe('message 14')

    // Should NOT have written a STATE_CHANGED event for each appendMessage.
    const events = await db.query.domainEvents.findMany({
      where: eq(domainEvents.aggregateId, conv.id),
    })
    expect(events.some(e => e.eventType === 'STATE_CHANGED')).toBe(false)
  })
})
