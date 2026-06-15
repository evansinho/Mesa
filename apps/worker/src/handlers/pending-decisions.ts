import type { Db } from '@mesa/db'
import { agentTasks } from '@mesa/db'
import type { Redis } from 'ioredis'
import { and, desc, eq, sql } from 'drizzle-orm'

export type PendingDecisionType =
  | 'PENDING_ORDER_CONFIRMATION'
  | 'PENDING_PAYMENT_REVIEW'
  | 'PENDING_FULFILMENT_DECISION'

export interface PendingOrderPayload {
  conversationId: string
  customerPhone: string
  items: Array<{ productName: string; quantity: number; unitPrice?: number }>
  agreedTotal: number
  prompt: string
  actionToken?: string
  actionUrl?: string
  nudgedAt?: string
  createdAt: string
}

export interface PendingPaymentPayload {
  orderId: string
  reason:
    | 'low_confidence'
    | 'amount_mismatch'
    | 'mono_failed'
    | 'reference_reused'
    | 'mono_required'
  received?: number
  expected?: number
  screenshotUrl?: string
  reference?: string
  conflictingPaymentId?: string
  actionToken?: string
  actionUrl?: string
  notYetCount?: number
  lastNotYetAt?: string
  nextReminderAt?: string
  remindersStopped?: boolean
  nudgedAt?: string
  createdAt: string
}

export interface PendingFulfilmentPayload {
  orderId: string
  fulfilmentId: string
  customerPhone: string
  customerName?: string
  itemsSummary: string
  totalPaid: number
  actionUrl?: string
  nudgedAt?: string
  createdAt: string
}

export type PendingPayload = PendingOrderPayload | PendingPaymentPayload | PendingFulfilmentPayload

// 24h Redis TTL. The DB row is the source of truth — Redis is just a fast lookup.
const PENDING_TTL_SECONDS = 60 * 60 * 24

function redisKey(merchantId: string, type: PendingDecisionType): string {
  // These keys match what the previous Redis-only implementation used, so
  // any in-flight pending state from before the migration is still findable.
  if (type === 'PENDING_ORDER_CONFIRMATION') return `pending_order_by_merchant:${merchantId}`
  if (type === 'PENDING_PAYMENT_REVIEW') return `pending_payment_by_merchant:${merchantId}`
  return `pending_fulfilment_by_merchant:${merchantId}`
}

export class PendingDecisions {
  constructor(
    private db: Db,
    private redis: Redis,
  ) {}

  // Upsert a pending decision. Latest write wins — matches the previous
  // Redis-only "setex overwrites" behavior, just durably.
  async upsert(
    merchantId: string,
    type: 'PENDING_ORDER_CONFIRMATION',
    payload: Omit<PendingOrderPayload, 'createdAt'>,
  ): Promise<string>
  async upsert(
    merchantId: string,
    type: 'PENDING_PAYMENT_REVIEW',
    payload: Omit<PendingPaymentPayload, 'createdAt'>,
  ): Promise<string>
  async upsert(
    merchantId: string,
    type: 'PENDING_FULFILMENT_DECISION',
    payload: Omit<PendingFulfilmentPayload, 'createdAt'>,
  ): Promise<string>
  async upsert(
    merchantId: string,
    type: PendingDecisionType,
    payload:
      | Omit<PendingOrderPayload, 'createdAt'>
      | Omit<PendingPaymentPayload, 'createdAt'>
      | Omit<PendingFulfilmentPayload, 'createdAt'>,
  ): Promise<string> {
    const now = new Date()
    const fullPayload = { ...payload, createdAt: now.toISOString() } as unknown as Record<string, unknown>

    const [row] = await this.db
      .insert(agentTasks)
      .values({ merchantId, type, status: 'OPEN', payload: fullPayload })
      .onConflictDoUpdate({
        target: [agentTasks.merchantId, agentTasks.type],
        targetWhere: sql`status = 'OPEN' AND type IN ('PENDING_ORDER_CONFIRMATION', 'PENDING_PAYMENT_REVIEW', 'PENDING_FULFILMENT_DECISION')`,
        set: { payload: fullPayload, createdAt: now },
      })
      .returning({ id: agentTasks.id })

    await this.redis.setex(redisKey(merchantId, type), PENDING_TTL_SECONDS, JSON.stringify(fullPayload))
    return row.id
  }

  // Fetch the active pending decision. Redis hot path; DB fallback rehydrates
  // the cache. Returns null when no OPEN row exists.
  async get<T extends PendingPayload>(
    merchantId: string,
    type: PendingDecisionType,
  ): Promise<T | null> {
    const cached = await this.redis.get(redisKey(merchantId, type))
    if (cached) return JSON.parse(cached) as T

    const row = await this.db.query.agentTasks.findFirst({
      where: and(
        eq(agentTasks.merchantId, merchantId),
        eq(agentTasks.type, type),
        eq(agentTasks.status, 'OPEN'),
      ),
      orderBy: [desc(agentTasks.createdAt)],
    })
    if (!row) return null

    const payload = row.payload as unknown as T
    await this.redis.setex(redisKey(merchantId, type), PENDING_TTL_SECONDS, JSON.stringify(payload))
    return payload
  }

  async update<T extends PendingPayload>(
    merchantId: string,
    type: PendingDecisionType,
    patch: Partial<T>,
  ): Promise<T | null> {
    const row = await this.db.query.agentTasks.findFirst({
      where: and(
        eq(agentTasks.merchantId, merchantId),
        eq(agentTasks.type, type),
        eq(agentTasks.status, 'OPEN'),
      ),
      orderBy: [desc(agentTasks.createdAt)],
    })
    if (!row) return null

    const payload = {
      ...(row.payload as Record<string, unknown>),
      ...(patch as Record<string, unknown>),
    } as unknown as T

    await this.db
      .update(agentTasks)
      .set({ payload: payload as unknown as Record<string, unknown> })
      .where(eq(agentTasks.id, row.id))
    await this.redis.setex(redisKey(merchantId, type), PENDING_TTL_SECONDS, JSON.stringify(payload))
    return payload
  }

  // Resolve the active pending decision. Sets the DB row to the final status
  // and clears the Redis cache.
  async resolve(
    merchantId: string,
    type: PendingDecisionType,
    resolution: 'DONE' | 'CANCELLED',
  ): Promise<void> {
    await this.db
      .update(agentTasks)
      .set({ status: resolution })
      .where(and(
        eq(agentTasks.merchantId, merchantId),
        eq(agentTasks.type, type),
        eq(agentTasks.status, 'OPEN'),
      ))
    await this.redis.del(redisKey(merchantId, type))
  }
}
