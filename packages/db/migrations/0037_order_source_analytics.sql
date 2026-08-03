ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "source_confidence" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_confidence" text;

CREATE TABLE IF NOT EXISTS "tracking_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "slug" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "tracking_links_slug_idx" ON "tracking_links" ("slug");
CREATE INDEX IF NOT EXISTS "tracking_links_merchant_idx" ON "tracking_links" ("merchant_id");

CREATE TABLE IF NOT EXISTS "tracking_link_clicks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tracking_link_id" uuid NOT NULL REFERENCES "tracking_links"("id") ON DELETE CASCADE,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "clicked_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "tracking_link_clicks_link_idx" ON "tracking_link_clicks" ("tracking_link_id");
CREATE INDEX IF NOT EXISTS "tracking_link_clicks_merchant_idx" ON "tracking_link_clicks" ("merchant_id");
