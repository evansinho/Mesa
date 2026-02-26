import type { Redis } from 'ioredis'
import type { Db } from '@mesa/db'
import { domainEvents } from '@mesa/db'
import {
  ConversationState,
  ConversationContext,
  VALID_TRANSITIONS,
} from '@mesa/types'

const CONVERSATION_KEY = (merchantId: string, channel: string, customerId: string) =>
  `conversation:${merchantId}:${channel}:${customerId}`

const CONVERSATION_TTL = 60 * 60 * 2 // 2 hours idle timeout

interface ConversationRecord {
  id: string
  merchantId: string
  channel: string
  customerPhone: string
  state: ConversationState
  context: ConversationContext
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
    const existing = await this.get(merchantId, channel, customerId)
    if (existing) return existing

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

    await this.save(updated)
    await this.persistEvent(updated, from, to)

    return updated
  }

  canTransition(from: ConversationState, to: ConversationState): boolean {
    return VALID_TRANSITIONS[from].includes(to)
  }

  private async save(record: ConversationRecord): Promise<void> {
    const key = CONVERSATION_KEY(record.merchantId, record.channel, record.customerPhone)
    await this.redis.setex(key, CONVERSATION_TTL, JSON.stringify(record))
  }

  private async persistEvent(
    record: ConversationRecord,
    from: ConversationState,
    to: ConversationState
  ): Promise<void> {
    await this.db.insert(domainEvents).values({
      aggregateId: record.id,
      aggregateType: 'conversation',
      eventType: 'STATE_CHANGED',
      payload: {
        from,
        to,
        merchantId: record.merchantId,
        customerPhone: record.customerPhone,
        context: record.context,
      },
    })
  }

  async reset(merchantId: string, channel: string, customerId: string): Promise<void> {
    const key = CONVERSATION_KEY(merchantId, channel, customerId)
    await this.redis.del(key)
  }
}
