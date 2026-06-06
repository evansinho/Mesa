CREATE TYPE billing_event_type AS ENUM (
  'trial_started',
  'trial_warning_sent',
  'trial_expired',
  'subscription_created',
  'charge_success',
  'charge_failed',
  'subscription_cancelled'
);

CREATE TABLE billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  type billing_event_type NOT NULL,
  event_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX billing_events_event_key_idx
  ON billing_events (event_key)
  WHERE event_key IS NOT NULL;

CREATE INDEX billing_events_merchant_idx
  ON billing_events (merchant_id, created_at DESC);
