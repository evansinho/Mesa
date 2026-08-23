ALTER TABLE "fulfilments" ADD COLUMN IF NOT EXISTS "dropoff_state" text;
ALTER TABLE "fulfilments" ADD COLUMN IF NOT EXISTS "provider" text;
ALTER TABLE "fulfilments" ADD COLUMN IF NOT EXISTS "provider_quote_id" text;
ALTER TABLE "fulfilments" ADD COLUMN IF NOT EXISTS "provider_order_id" text;
ALTER TABLE "fulfilments" ADD COLUMN IF NOT EXISTS "delivery_fee_kobo" integer;
ALTER TABLE "fulfilments" ADD COLUMN IF NOT EXISTS "quote_expires_at" timestamp with time zone;
ALTER TABLE "fulfilments" ADD COLUMN IF NOT EXISTS "tracking_url" text;
ALTER TABLE "fulfilments" ADD COLUMN IF NOT EXISTS "provider_status" text;

-- Structurally prevents double-booking the same real provider order across
-- two different fulfilments, and is what a FEZ webhook or Kwik poll uses to
-- find the right row.
CREATE UNIQUE INDEX IF NOT EXISTS "fulfilments_provider_order_idx"
  ON "fulfilments" ("provider", "provider_order_id")
  WHERE "provider_order_id" IS NOT NULL;
