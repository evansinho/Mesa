-- Add unique constraint for idempotent domain events
CREATE UNIQUE INDEX domain_events_aggregate_event_idx
  ON domain_events (aggregate_id, event_type);
