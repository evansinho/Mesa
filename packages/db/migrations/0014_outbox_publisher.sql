-- F-6: Transactional outbox infrastructure on domain_events.
--
-- Adds the bookkeeping columns the publisher needs, plus indexes to support
-- fast polling. Also corrects a pre-existing bug: migration 0001 created a
-- global UNIQUE index on (aggregate_id, event_type) which is incompatible
-- with STATE_CHANGED rows (one per state transition per conversation). The
-- correct shape is a partial unique index restricted to the once-only event
-- types.

-- 1. Outbox bookkeeping columns.
ALTER TABLE domain_events
  ADD COLUMN IF NOT EXISTS published_at timestamp,
  ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_publish_error text;

-- 2. Polling index: scan unpublished rows in chronological order.
CREATE INDEX IF NOT EXISTS domain_events_unpublished_idx
  ON domain_events (created_at)
  WHERE published_at IS NULL;

-- 3. Rebuild the (aggregate_id, event_type) index as non-unique to match the
--    schema definition. Migration 0001 created it as UNIQUE which is incorrect.
DROP INDEX IF EXISTS domain_events_aggregate_event_idx;
CREATE INDEX IF NOT EXISTS domain_events_aggregate_event_idx
  ON domain_events (aggregate_id, event_type);

-- 4. Partial unique index for atomic appendOnce. Each aggregate may have at
--    most one row of each of these event types. Other event types (e.g.
--    STATE_CHANGED) are explicitly NOT covered and may repeat freely.
CREATE UNIQUE INDEX IF NOT EXISTS domain_events_appendonce_idx
  ON domain_events (aggregate_id, event_type)
  WHERE event_type IN (
    'ORDER_DETECTED',
    'ORDER_CONFIRMED',
    'PAYMENT_SCREENSHOT_RECEIVED',
    'PAYMENT_CONFIRMED'
  );