CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  plan subscription_tier NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL,
  paystack_customer_code TEXT,
  paystack_subscription_code TEXT,
  paystack_email_token TEXT,
  paystack_plan_code TEXT NOT NULL,
  amount_kobo INTEGER NOT NULL,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX subscriptions_merchant_idx ON subscriptions (merchant_id);
CREATE INDEX subscriptions_paystack_subscription_code_idx ON subscriptions (paystack_subscription_code);
CREATE UNIQUE INDEX subscriptions_merchant_active_idx
  ON subscriptions (merchant_id)
  WHERE status = 'active';
