-- Allow multiple order-detected events for the same conversation.
--
-- A customer can place more than one order in one WhatsApp thread. Keeping
-- ORDER_DETECTED in this append-once index suppressed later orders after the
-- first review card. Confirmations and payment events remain idempotent.
DROP INDEX IF EXISTS domain_events_appendonce_idx;

CREATE UNIQUE INDEX IF NOT EXISTS domain_events_appendonce_idx
  ON domain_events (aggregate_id, event_type)
  WHERE event_type IN (
    'ORDER_CONFIRMED',
    'PAYMENT_SCREENSHOT_RECEIVED',
    'PAYMENT_CONFIRMED'
  );
