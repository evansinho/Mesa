import type { Db } from '@mesa/db'
import { agentTasks } from '@mesa/db'
import type { Redis } from 'ioredis'
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { agentTasksCreated } from '../metrics'

export type PendingDecisionType =
  | 'PENDING_ORDER_CONFIRMATION'
  | 'PENDING_PAYMENT_REVIEW'
  | 'PENDING_FULFILMENT_DECISION'
  | 'PENDING_PRODUCT_MEDIA_CONFIRMATION'

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
  // The channel the underlying order came from — needed because the
  // merchant resolves this decision via a WhatsApp-only reply flow
  // regardless of which channel the customer actually used, so the
  // customer-facing sends triggered by that reply can't infer it from
  // the reply itself.
  customerChannel: string
  customerName?: string
  itemsSummary: string
  totalPaid: number
  actionUrl?: string
  nudgedAt?: string
  createdAt: string
}

export interface PendingProductMediaPayload {
  conversationId: string
  customerPhone: string
  mediaUrl: string
  mediaLabel: 'image' | 'document'
  candidateProductName?: string
  nudgedAt?: string
  createdAt: string
}

export type PendingPayload = PendingOrderPayload | PendingPaymentPayload | PendingFulfilmentPayload | PendingProductMediaPayload

export interface UpsertResult {
  id: string
  // Whether this item is the one currently shown to the merchant. false
  // means it was queued behind an already-surfaced item for the same
  // merchant+type and is waiting silently — callers must not notify for it.
  surfaced: boolean
}

export interface ResolveResult {
  // Whether this call actually claimed the surfaced row (the atomic
  // compare-and-swap). Same semantics as the old boolean return — callers
  // that create a side effect MUST check this before doing so.
  claimed: boolean
  // The next queued item, now promoted to surfaced, if any. Callers must
  // notify the merchant about it when non-null.
  promoted: PendingPayload | null
}

// 24h Redis TTL. The DB row is the source of truth — Redis is just a fast lookup.
const PENDING_TTL_SECONDS = 60 * 60 * 24

function redisKey(merchantId: string, type: PendingDecisionType): string {
  // These keys match what the previous Redis-only implementation used, so
  // any in-flight pending state from before the migration is still findable.
  if (type === 'PENDING_ORDER_CONFIRMATION') return `pending_order_by_merchant:${merchantId}`
  if (type === 'PENDING_PAYMENT_REVIEW') return `pending_payment_by_merchant:${merchantId}`
  if (type === 'PENDING_FULFILMENT_DECISION') return `pending_fulfilment_by_merchant:${merchantId}`
  return `pending_product_media_by_merchant:${merchantId}`
}

// What makes two upserts "the same pending item" (update in place) vs. "a
// different one" (queue behind whatever's already current) for a given type.
function identityValue(type: PendingDecisionType, payload: Record<string, unknown>): string | undefined {
  switch (type) {
    case 'PENDING_ORDER_CONFIRMATION':
    case 'PENDING_PRODUCT_MEDIA_CONFIRMATION':
      return payload.conversationId as string | undefined
    case 'PENDING_PAYMENT_REVIEW':
    case 'PENDING_FULFILMENT_DECISION':
      return payload.orderId as string | undefined
  }
}

export class PendingDecisions {
  constructor(
    private db: Db,
    private redis: Redis,
  ) {}

  // Upsert a pending decision.
  //  - Same identity (conversationId for order confirmation, orderId for
  //    payment review / fulfilment decision) as an already-OPEN row for this
  //    merchant+type: update that row's payload in place, whether it's
  //    currently surfaced or still queued.
  //  - Otherwise: insert a new row. It becomes surfaced (shown immediately)
  //    only if nothing else for this merchant+type currently is; otherwise it
  //    queues silently behind whatever's already current.
  async upsert(
    merchantId: string,
    type: 'PENDING_ORDER_CONFIRMATION',
    payload: Omit<PendingOrderPayload, 'createdAt'>,
  ): Promise<UpsertResult>
  async upsert(
    merchantId: string,
    type: 'PENDING_PAYMENT_REVIEW',
    payload: Omit<PendingPaymentPayload, 'createdAt'>,
  ): Promise<UpsertResult>
  async upsert(
    merchantId: string,
    type: 'PENDING_FULFILMENT_DECISION',
    payload: Omit<PendingFulfilmentPayload, 'createdAt'>,
  ): Promise<UpsertResult>
  async upsert(
    merchantId: string,
    type: 'PENDING_PRODUCT_MEDIA_CONFIRMATION',
    payload: Omit<PendingProductMediaPayload, 'createdAt'>,
  ): Promise<UpsertResult>
  async upsert(
    merchantId: string,
    type: PendingDecisionType,
    payload:
      | Omit<PendingOrderPayload, 'createdAt'>
      | Omit<PendingPaymentPayload, 'createdAt'>
      | Omit<PendingFulfilmentPayload, 'createdAt'>
      | Omit<PendingProductMediaPayload, 'createdAt'>,
  ): Promise<UpsertResult> {
    const now = new Date()
    const fullPayload = { ...payload, createdAt: now.toISOString() } as unknown as Record<string, unknown>
    const identity = identityValue(type, fullPayload)

    const findOpenRows = () => this.db.query.agentTasks.findMany({
      where: and(
        eq(agentTasks.merchantId, merchantId),
        eq(agentTasks.type, type),
        eq(agentTasks.status, 'OPEN'),
      ),
      orderBy: [desc(agentTasks.createdAt)],
    })

    const updateExisting = async (row: { id: string; surfacedAt: Date | null }): Promise<UpsertResult> => {
      await this.db
        .update(agentTasks)
        .set({ payload: fullPayload, createdAt: now })
        .where(eq(agentTasks.id, row.id))
      const surfaced = row.surfacedAt != null
      if (surfaced) {
        await this.redis.setex(redisKey(merchantId, type), PENDING_TTL_SECONDS, JSON.stringify(fullPayload))
      }
      return { id: row.id, surfaced }
    }

    const insertRow = async (surfaced: boolean): Promise<UpsertResult> => {
      const [row] = await this.db
        .insert(agentTasks)
        .values({ merchantId, type, status: 'OPEN', payload: fullPayload, surfacedAt: surfaced ? now : null })
        .returning({ id: agentTasks.id })

      agentTasksCreated.add(1, { type })
      if (surfaced) {
        await this.redis.setex(redisKey(merchantId, type), PENDING_TTL_SECONDS, JSON.stringify(fullPayload))
      }
      return { id: row.id, surfaced }
    }

    const openRows = await findOpenRows()

    if (identity != null) {
      const match = openRows.find(r => identityValue(type, r.payload as Record<string, unknown>) === identity)
      if (match) return updateExisting(match)
    }

    const anySurfaced = openRows.some(r => r.surfacedAt != null)

    try {
      return await insertRow(!anySurfaced)
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err
      // Lost a race: a concurrent upsert for a different identity inserted
      // its row as surfaced in the gap between the read above and this
      // insert. Re-check what's actually there now — if it turns out to be
      // the same identity after all, update in place; otherwise this one
      // just queues behind whichever row won.
      const retryRows = await findOpenRows()
      if (identity != null) {
        const match = retryRows.find(r => identityValue(type, r.payload as Record<string, unknown>) === identity)
        if (match) return updateExisting(match)
      }
      return insertRow(false)
    }
  }

  // Fetch the currently-surfaced pending decision. Redis hot path; DB
  // fallback rehydrates the cache. Returns null when no surfaced OPEN row
  // exists — a queued item is invisible here by design, since a merchant's
  // bare-keyword reply must only ever resolve what they're actually looking
  // at, never something still waiting in the queue.
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
        isNotNull(agentTasks.surfacedAt),
      ),
      orderBy: [desc(agentTasks.surfacedAt)],
    })
    if (!row) return null

    const payload = row.payload as unknown as T
    await this.redis.setex(redisKey(merchantId, type), PENDING_TTL_SECONDS, JSON.stringify(payload))
    return payload
  }

  // Patch the currently-surfaced item. Same "invisible to queued items" scope
  // as get() — use updateById to patch a specific row regardless of surfaced
  // state (e.g. attaching an action token right after upsert creates it).
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
        isNotNull(agentTasks.surfacedAt),
      ),
      orderBy: [desc(agentTasks.surfacedAt)],
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

  // Patch a specific row by id, regardless of whether it's currently
  // surfaced or still queued — for attaching an action token to the exact
  // row upsert() just returned.
  async updateById<T extends PendingPayload>(id: string, patch: Partial<T>): Promise<T | null> {
    const row = await this.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, id) })
    if (!row) return null

    const payload = {
      ...(row.payload as Record<string, unknown>),
      ...(patch as Record<string, unknown>),
    } as unknown as T

    await this.db
      .update(agentTasks)
      .set({ payload: payload as unknown as Record<string, unknown> })
      .where(eq(agentTasks.id, id))
    if (row.surfacedAt) {
      await this.redis.setex(redisKey(row.merchantId, row.type as PendingDecisionType), PENDING_TTL_SECONDS, JSON.stringify(payload))
    }
    return payload
  }

  // Promote the oldest queued item (if any) to surfaced. Shared by resolve()
  // and the worker's self-heal cron (which covers the dashboard action-link
  // path, where a resolution doesn't call this directly). Returns its
  // payload, or null if the queue is empty.
  async promoteNext(merchantId: string, type: PendingDecisionType): Promise<PendingPayload | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.db.query.agentTasks.findFirst({
        where: and(
          eq(agentTasks.merchantId, merchantId),
          eq(agentTasks.type, type),
          eq(agentTasks.status, 'OPEN'),
          isNull(agentTasks.surfacedAt),
        ),
        orderBy: [asc(agentTasks.createdAt)],
      })
      if (!candidate) return null

      try {
        const [row] = await this.db
          .update(agentTasks)
          .set({ surfacedAt: new Date() })
          .where(and(eq(agentTasks.id, candidate.id), isNull(agentTasks.surfacedAt)))
          .returning({ payload: agentTasks.payload })
        if (!row) continue // another promoteNext call claimed this exact row first — try the next one

        const payload = row.payload as unknown as PendingPayload
        await this.redis.setex(redisKey(merchantId, type), PENDING_TTL_SECONDS, JSON.stringify(payload))
        return payload
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err
        // Lost the race to a concurrent upsert that inserted a brand new row
        // as surfaced for this merchant+type in the gap between the read
        // above and this update. Nothing to promote right now — a later
        // resolve() or the self-heal cron will retry.
        return null
      }
    }
    return null
  }

  // Resolve the currently-surfaced pending decision. Sets the DB row to the
  // final status, clears the Redis cache, and promotes whatever was queued
  // behind it (if anything). `claimed` is the atomic compare-and-swap result
  // — the same task can also be resolved from the web action page
  // independently, so callers that create a side effect (e.g. an order) MUST
  // check this before doing so, not after, or both paths can win the race.
  // `promoted` is non-null when a queued item just became the new current
  // one — callers MUST notify the merchant about it.
  async resolve(
    merchantId: string,
    type: PendingDecisionType,
    resolution: 'DONE' | 'CANCELLED',
  ): Promise<ResolveResult> {
    const [claimed] = await this.db
      .update(agentTasks)
      .set({ status: resolution })
      .where(and(
        eq(agentTasks.merchantId, merchantId),
        eq(agentTasks.type, type),
        eq(agentTasks.status, 'OPEN'),
        isNotNull(agentTasks.surfacedAt),
      ))
      .returning({ id: agentTasks.id })
    await this.redis.del(redisKey(merchantId, type))
    if (!claimed) return { claimed: false, promoted: null }

    const promoted = await this.promoteNext(merchantId, type)
    return { claimed: true, promoted }
  }
}
