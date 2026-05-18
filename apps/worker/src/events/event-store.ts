import type { Db } from '@mesa/db'
import { domainEvents } from '@mesa/db'
import { sql } from 'drizzle-orm'
import type { MesaNatsClient } from '@mesa/nats'
import { EVENT_TYPE_META, SUBJECT_TO_EVENT_TYPE } from './event-meta'

type DomainEventPayload = Record<string, unknown>

const EVENT_VERSION = 1

export type OutboxMode = 'off' | 'shadow' | 'active'

// Event types covered by the partial unique index `domain_events_appendonce_idx`
// — appendOnce is only atomic for these. Keep in sync with migration 0014.
const APPEND_ONCE_EVENT_TYPES = new Set([
  'ORDER_DETECTED',
  'ORDER_CONFIRMED',
  'PAYMENT_SCREENSHOT_RECEIVED',
  'PAYMENT_CONFIRMED',
])

export class EventStore {
  constructor(
    private db: Db,
    private nats?: MesaNatsClient,
    private mode: OutboxMode = 'off',
  ) {}

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

  // Single chokepoint for emitting a state-change event. The handler builds
  // the event in its usual shape (with `subject` from `SUBJECTS.*`); emit
  // routes it through the outbox + the right delivery path per mode.
  //
  // For events NOT in EVENT_TYPE_META (notifications, inbound), emit falls
  // through to a direct NATS publish — callers can use emit uniformly.
  //
  // Mode semantics (each event fires exactly once in every mode):
  //   off    — write outbox + direct publish from here
  //   shadow — write outbox + direct publish from here (publisher logs only)
  //   active — write outbox only; outbox publisher does the NATS publish
  async emit<E extends { subject: string }>(event: E): Promise<void> {
    const eventType = SUBJECT_TO_EVENT_TYPE[event.subject]
    const eventRecord = event as unknown as Record<string, unknown>

    if (!eventType) {
      // Not an outboxable state-change event. Pure side effect (notification)
      // or an inbound event — publish directly.
      if (this.nats) await this.nats.publish(event)
      return
    }

    const meta = EVENT_TYPE_META[eventType]
    const aggregateId = eventRecord[meta.aggregateField]
    if (typeof aggregateId !== 'string' || aggregateId.length === 0) {
      throw new Error(`emit(${eventType}): missing or invalid ${meta.aggregateField}`)
    }

    const { subject: _subject, ...payload } = eventRecord
    await this.appendOnce(aggregateId, meta.aggregateType, eventType, payload)

    if (this.mode !== 'active' && this.nats) {
      await this.nats.publish(event)
    }
  }

  // Minimal sanity check: every outboxable event must carry a merchantId so
  // downstream consumers can route per tenant. Per-event field checks were
  // previously here but didn't match what the handlers actually publish —
  // they enforced fields that never made it into the nats event shape. The
  // typesystem on the event union (packages/types/src/events.ts) is the
  // real enforcement.
  private validate(eventType: string, payload: DomainEventPayload): void {
    if (!EVENT_TYPE_META[eventType]) return
    if (typeof payload.merchantId !== 'string' || payload.merchantId.length === 0) {
      throw new Error(`Invalid payload for event ${eventType}: missing merchantId`)
    }
  }
}
