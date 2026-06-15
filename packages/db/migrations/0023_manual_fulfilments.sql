CREATE TYPE fulfilment_mode AS ENUM (
  'BOOK_RIDER',
  'SELF_DELIVER',
  'CUSTOMER_PICKUP',
  'MANUAL'
);

CREATE TYPE fulfilment_status AS ENUM (
  'PENDING',
  'ADDRESS_REQUIRED',
  'READY_FOR_DISPATCH',
  'SELF_DELIVERY',
  'CUSTOMER_PICKUP',
  'DELIVERED',
  'CANCELLED',
  'MANUAL'
);

CREATE TABLE fulfilments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  mode fulfilment_mode,
  status fulfilment_status NOT NULL DEFAULT 'PENDING',
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  pickup_address TEXT,
  dropoff_address TEXT,
  package_description TEXT,
  package_value NUMERIC(12, 2),
  dispatch_summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX fulfilments_order_id_idx ON fulfilments(order_id);
CREATE INDEX fulfilments_merchant_status_idx ON fulfilments(merchant_id, status);

DROP INDEX IF EXISTS agent_tasks_pending_decision_unique_idx;
CREATE UNIQUE INDEX agent_tasks_pending_decision_unique_idx
  ON agent_tasks (merchant_id, type)
  WHERE status = 'OPEN'
    AND type IN (
      'PENDING_ORDER_CONFIRMATION',
      'PENDING_PAYMENT_REVIEW',
      'PENDING_FULFILMENT_DECISION'
    );
