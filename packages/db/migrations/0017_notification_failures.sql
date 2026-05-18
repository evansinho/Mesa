-- F-13: Audit trail for outbound notification delivery failures.

CREATE TABLE IF NOT EXISTS notification_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  channel text NOT NULL,
  recipient text NOT NULL,
  message text NOT NULL,
  error_message text NOT NULL,
  resolved_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_failures_merchant_idx ON notification_failures (merchant_id);
CREATE INDEX IF NOT EXISTS notification_failures_unresolved_idx ON notification_failures (created_at) WHERE resolved_at IS NULL;