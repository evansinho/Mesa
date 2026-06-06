CREATE TYPE subscription_status AS ENUM (
  'trialing',
  'active',
  'past_due',
  'expired',
  'cancelled'
);

ALTER TABLE merchants
  ADD COLUMN email TEXT,
  ADD COLUMN trial_ends_at TIMESTAMPTZ,
  ADD COLUMN subscription_status subscription_status NOT NULL DEFAULT 'trialing';

UPDATE merchants
  SET trial_ends_at = NOW() + INTERVAL '7 days',
      subscription_status = 'trialing'
  WHERE trial_ends_at IS NULL;

ALTER TABLE merchants
  ALTER COLUMN trial_ends_at SET NOT NULL;
