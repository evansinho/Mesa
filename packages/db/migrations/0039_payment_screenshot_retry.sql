-- A customer can legitimately submit more than one payment screenshot for
-- the same order (a wrong photo, or a retry after the first failed
-- verification). Keeping PAYMENT_SCREENSHOT_RECEIVED in this append-once
-- index silently dropped every screenshot after the first, forever, since
-- idempotency was keyed by orderId alone. payment.handler.ts already
-- de-dupes by screenshotHash, which is the correct granularity for "don't
-- reprocess the exact same image twice."
DROP INDEX IF EXISTS domain_events_appendonce_idx;

CREATE UNIQUE INDEX IF NOT EXISTS domain_events_appendonce_idx
  ON domain_events (aggregate_id, event_type)
  WHERE event_type IN (
    'ORDER_CONFIRMED',
    'PAYMENT_CONFIRMED'
  );
