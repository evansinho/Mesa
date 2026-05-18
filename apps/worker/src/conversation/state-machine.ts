import type { Redis } from 'ioredis'
import type { Db } from '@mesa/db'
import { conversations, domainEvents } from '@mesa/db'
import { eq } from 'drizzle-orm'
import {
  ConversationState,
  ConversationContext,
  VALID_TRANSITIONS,
} from '@mesa/types'

const CONVERSATION_KEY = (merchantId: string, channel: string, customerId: string) =>
  `conversation:${merchantId}:${channel}:${customerId}`

const CONVERSATION_TTL = 60 * 60 * 2 // 2 hours idle timeout — Redis is cache only; DB is source of truth

interface ConversationRecord {
  id: string
  merchantId: string
  channel: string
  customerPhone: string
  state: ConversationState
  context: ConversationContext
}

export function hydrateContext(raw: unknown): ConversationContext {
  const obj = (raw ?? {}) as Partial<ConversationContext>
  return {
    currentItems: Array.isArray(obj.currentItems) ? obj.currentItems : [],
    negotiationHistory: Array.isArray(obj.negotiationHistory) ? obj.negotiationHistory : [],
    lastQuotedPrice: obj.lastQuotedPrice,
    agreedPrice: obj.agreedPrice,
    orderId: obj.orderId,
    recentMessages: Array.isArray(obj.recentMessages) ? obj.recentMessages : undefined,
    lastMessageAt: typeof obj.lastMessageAt === 'string' ? obj.lastMessageAt : new Date().toISOString(),
  }
}

export class ConversationStateMachine {
  constructor(
    private redis: Redis,
    private db: Db
  ) {}

  async get(merchantId: string, channel: string, customerId: string): Promise<ConversationRecord | null> {
    const key = CONVERSATION_KEY(merchantId, channel, customerId)
    const raw = await this.redis.get(key)
    if (!raw) return null
    return JSON.parse(raw) as ConversationRecord
  }

  async getOrCreate(
    merchantId: string,
    channel: string,
    customerId: string,
    conversationId: string
  ): Promise<ConversationRecord> {
    // Hot path: Redis cache.
    const cached = await this.get(merchantId, channel, customerId)
    if (cached) return cached

    // Cache miss: rebuild from durable state in Postgres. The caller has already
    // inserted (or located) the conversations row via getOrCreateConversationId,
    // so a row should exist at `conversationId`.
    const row = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    })

    if (row) {
      const record: ConversationRecord = {
        id: row.id,
        merchantId: row.merchantId,
        channel: row.channel,
        customerPhone: row.customerPhone,
        state: row.state,
        context: hydrateContext(row.context),
      }
      await this.save(record)
      return record
    }

    // Defensive fallback: the row genuinely doesn't exist (e.g. raced delete).
    // Persist a fresh IDLE record so DB and cache agree.
    const record: ConversationRecord = {
      id: conversationId,
      merchantId,
      channel,
      customerPhone: customerId,
      state: 'IDLE',
      context: {
        currentItems: [],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    }

    await this.db
      .insert(conversations)
      .values({
        id: record.id,
        merchantId: record.merchantId,
        channel: record.channel,
        customerPhone: record.customerPhone,
        state: record.state,
        context: record.context as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing()
    await this.save(record)
    return record
  }

  async transition(
    record: ConversationRecord,
    to: ConversationState,
    contextUpdate: Partial<ConversationContext> = {}
  ): Promise<ConversationRecord> {
    const from = record.state

    if (!this.canTransition(from, to)) {
      throw new Error(`Invalid transition: ${from} → ${to}`)
    }

    const updated: ConversationRecord = {
      ...record,
      state: to,
      context: {
        ...record.context,
        ...contextUpdate,
        lastMessageAt: new Date().toISOString(),
      },
    }

    // Durable commit first: state + context on the conversations row and the
    // STATE_CHANGED audit row in domain_events go in a single transaction.
    // If this throws, no Redis update happens and the next read still sees
    // the pre-transition state.
    await this.db.transaction(async (tx) => {
      await tx
        .update(conversations)
        .set({
          state: updated.state,
          context: updated.context as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, updated.id))

      await tx.insert(domainEvents).values({
        aggregateId: updated.id,
        aggregateType: 'conversation',
        eventType: 'STATE_CHANGED',
        payload: {
          from,
          to,
          merchantId: updated.merchantId,
          customerPhone: updated.customerPhone,
          context: updated.context,
        },
      })
    })

    // Cache after durable commit. If Redis save fails, the next read falls
    // back to DB and rehydrates — no correctness loss.
    await this.save(updated)

    return updated
  }

  canTransition(from: ConversationState, to: ConversationState): boolean {
    return VALID_TRANSITIONS[from].includes(to)
  }

  private async save(record: ConversationRecord): Promise<void> {
    const key = CONVERSATION_KEY(record.merchantId, record.channel, record.customerPhone)
    await this.redis.setex(key, CONVERSATION_TTL, JSON.stringify(record))
  }

  // Append a message to the rolling recent-messages buffer used for NLP
  // context. Persists to DB + cache without emitting a STATE_CHANGED event
  // (this is context enrichment, not a state transition).
  async appendMessage(
    record: ConversationRecord,
    role: 'customer' | 'vendor',
    text: string,
    maxRecent = 10,
  ): Promise<ConversationRecord> {
    const recent = (record.context.recentMessages ?? []).slice()
    recent.push({ role, text, ts: new Date().toISOString() })
    const trimmed = recent.slice(-maxRecent)

    const updated: ConversationRecord = {
      ...record,
      context: { ...record.context, recentMessages: trimmed },
    }

    await this.db
      .update(conversations)
      .set({
        context: updated.context as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, record.id))
    await this.save(updated)
    return updated
  }

  async reset(merchantId: string, channel: string, customerId: string): Promise<void> {
    const key = CONVERSATION_KEY(merchantId, channel, customerId)
    await this.redis.del(key)
  }
}
