import type { Db } from '@mesa/db'
import { domainEvents } from '@mesa/db'
import { sql } from 'drizzle-orm'

type DomainEventPayload = Record<string, unknown>

const EVENT_VERSION = 1

// Event types covered by the partial unique index `domain_events_appendonce_idx`
// — appendOnce is only atomic for these. Keep in sync with migration 0014.
const APPEND_ONCE_EVENT_TYPES = new Set([
  'ORDER_DETECTED',
  'ORDER_CONFIRMED',
  'PAYMENT_SCREENSHOT_RECEIVED',
  'PAYMENT_CONFIRMED',
])

export class EventStore {
  constructor(private db: Db) {}

  async append(
    aggregateId: string,
    aggregateType: string,
    eventType: string,
    payload: DomainEventPayload
  ): Promise<void> {
    this.validate(eventType, payload)
    await this.db.insert(domainEvents).values({
      aggregateId,
      aggregateType,
      eventType,
      payload: {
        v: EVENT_VERSION,
        data: payload,
      },
    })
  }

  // Append a domain event idempotently. Atomic via Postgres partial unique
  // index: a second call with the same (aggregateId, eventType) returns false
  // with no second row inserted. The read-then-write pattern this replaces was
  // racy under concurrency.
  //
  // Only event types in APPEND_ONCE_EVENT_TYPES get atomic idempotency — the
  // partial unique index is restricted to that set. Calling appendOnce with
  // any other event type silently degrades to a regular insert.
  async appendOnce(
    aggregateId: string,
    aggregateType: string,
    eventType: string,
    payload: DomainEventPayload
  ): Promise<boolean> {
    this.validate(eventType, payload)
    if (!APPEND_ONCE_EVENT_TYPES.has(eventType)) {
      await this.append(aggregateId, aggregateType, eventType, payload)
      return true
    }
    const inserted = await this.db
      .insert(domainEvents)
      .values({
        aggregateId,
        aggregateType,
        eventType,
        payload: { v: EVENT_VERSION, data: payload },
      })
      .onConflictDoNothing({
        target: [domainEvents.aggregateId, domainEvents.eventType],
        where: sql`event_type IN ('ORDER_DETECTED', 'ORDER_CONFIRMED', 'PAYMENT_SCREENSHOT_RECEIVED', 'PAYMENT_CONFIRMED')`,
      })
      .returning({ id: domainEvents.id })
    return inserted.length > 0
  }

  private validate(eventType: string, payload: DomainEventPayload): void {
    const validators: Record<string, (p: DomainEventPayload) => boolean> = {
      ORDER_DETECTED: p => Array.isArray(p.items) && typeof p.merchantId === 'string',
      ORDER_CONFIRMED: p => typeof p.merchantId === 'string' && typeof p.total === 'number',
      PAYMENT_SCREENSHOT_RECEIVED: p => typeof p.merchantId === 'string' && typeof p.screenshotHash === 'string',
      PAYMENT_CONFIRMED: p => typeof p.merchantId === 'string' && typeof p.amount === 'number',
    }

    const validate = validators[eventType]
    if (!validate) return
    if (!validate(payload)) {
      throw new Error(`Invalid payload for event ${eventType}`)
    }
  }
}
