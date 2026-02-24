-- Baseline schema migration for Mesa
-- Generated manually from packages/db/src/schema/index.ts

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums
CREATE TYPE subscription_tier AS ENUM ('starter', 'growth', 'business');
CREATE TYPE conversation_state AS ENUM (
  'IDLE',
  'BROWSING',
  'NEGOTIATING',
  'AGREED',
  'ORDER_CREATED',
  'AWAITING_PAYMENT',
  'PAYMENT_RECEIVED',
  'COMPLETE'
);
CREATE TYPE order_status AS ENUM (
  'PENDING',
  'CONFIRMED',
  'AWAITING_PAYMENT',
  'PAID',
  'FULFILLED',
  'CANCELLED'
);
CREATE TYPE payment_status AS ENUM (
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'DISPUTED'
);
CREATE TYPE inventory_event_reason AS ENUM (
  'SALE',
  'RESTOCK',
  'ADJUSTMENT',
  'RETURN',
  'WRITE_OFF'
);

-- Tables
CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL,
  whatsapp_number_id text NOT NULL,
  business_type text,
  subscription_tier subscription_tier NOT NULL DEFAULT 'starter',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX merchants_phone_idx ON merchants (phone);
CREATE UNIQUE INDEX merchants_whatsapp_number_idx ON merchants (whatsapp_number_id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price numeric(12,2) NOT NULL,
  stock_quantity integer NOT NULL DEFAULT 0,
  low_stock_threshold integer NOT NULL DEFAULT 5,
  unit text NOT NULL DEFAULT 'unit',
  sku text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX products_merchant_idx ON products (merchant_id);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text,
  state conversation_state NOT NULL DEFAULT 'IDLE',
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX conversations_merchant_customer_idx ON conversations (merchant_id, customer_phone);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  conversation_id uuid REFERENCES conversations(id),
  customer_phone text NOT NULL,
  customer_name text,
  status order_status NOT NULL DEFAULT 'PENDING',
  subtotal numeric(12,2) NOT NULL,
  total numeric(12,2) NOT NULL,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX orders_merchant_idx ON orders (merchant_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id),
  product_name text NOT NULL,
  quantity integer NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  agreed_price numeric(12,2) NOT NULL
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  amount numeric(12,2),
  screenshot_url text,
  screenshot_hash text,
  status payment_status NOT NULL DEFAULT 'PENDING',
  raw_ocr_data jsonb,
  reference text,
  bank_name text,
  confirmed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payments_screenshot_hash_idx ON payments (screenshot_hash);
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE inventory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  delta integer NOT NULL,
  reason inventory_event_reason NOT NULL,
  order_id uuid REFERENCES orders(id),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX inventory_events_product_idx ON inventory_events (product_id);

CREATE TABLE domain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id text NOT NULL,
  aggregate_type text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX domain_events_aggregate_idx ON domain_events (aggregate_id, aggregate_type);
CREATE INDEX domain_events_created_at_idx ON domain_events (created_at);
