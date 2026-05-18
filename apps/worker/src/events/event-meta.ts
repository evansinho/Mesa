// Centralized metadata for state-change events that flow through the outbox.
//
// Two maps describe the same shape from two directions:
//   - EVENT_TYPE_META: eventType → { subject, aggregateField, aggregateType }
//   - SUBJECT_TO_EVENT_TYPE: NATS subject → eventType
//
// `emit()` in EventStore uses these to: derive eventType + aggregateId from an
// in-flight event, write to domain_events, and (in non-active modes) publish
// via NATS. The outbox publisher uses the same metadata to reconstruct the
// event shape when it reads from the outbox.
//
// Events NOT in these maps (NOTIFICATION_SEND, INBOUND_MESSAGE) are not
// outboxed — they're either pure side effects or events that have no DB
// write to bundle with. They publish directly.

export interface EventMeta {
  subject: string
  aggregateField: string
  aggregateType: 'conversation' | 'order' | 'product'
}

export const EVENT_TYPE_META: Record<string, EventMeta> = {
  ORDER_DETECTED:              { subject: 'mesa.order.detected',             aggregateField: 'conversationId', aggregateType: 'conversation' },
  ORDER_CONFIRMED:             { subject: 'mesa.order.confirmed',            aggregateField: 'orderId',        aggregateType: 'order' },
  PAYMENT_SCREENSHOT_RECEIVED: { subject: 'mesa.payment.screenshot_received', aggregateField: 'orderId',        aggregateType: 'order' },
  PAYMENT_CONFIRMED:           { subject: 'mesa.payment.confirmed',          aggregateField: 'orderId',        aggregateType: 'order' },
  PAYMENT_FAILED:              { subject: 'mesa.payment.failed',             aggregateField: 'orderId',        aggregateType: 'order' },
  INVENTORY_UPDATED:           { subject: 'mesa.inventory.updated',          aggregateField: 'productId',      aggregateType: 'product' },
  INVENTORY_LOW:               { subject: 'mesa.inventory.low',              aggregateField: 'productId',      aggregateType: 'product' },
}

export const SUBJECT_TO_EVENT_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT_TYPE_META).map(([eventType, meta]) => [meta.subject, eventType]),
)