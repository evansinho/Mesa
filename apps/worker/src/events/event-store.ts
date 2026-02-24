import type { Db } from '@mesa/db'
import { domainEvents } from '@mesa/db'
import { and, eq } from 'drizzle-orm'

type DomainEventPayload = Record<string, unknown>

const EVENT_VERSION = 1

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

  async appendOnce(
    aggregateId: string,
    aggregateType: string,
    eventType: string,
    payload: DomainEventPayload
  ): Promise<boolean> {
    const existing = await this.db.query.domainEvents.findFirst({
      where: and(
        eq(domainEvents.aggregateId, aggregateId),
        eq(domainEvents.eventType, eventType)
      ),
    })
    if (existing) return false

    await this.append(aggregateId, aggregateType, eventType, payload)
    return true
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
