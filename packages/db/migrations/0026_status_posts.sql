ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "image_url" text;

CREATE TABLE IF NOT EXISTS "status_posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "caption" text NOT NULL,
  "image_url" text,
  "posted_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "status_posts_merchant_idx" ON "status_posts" ("merchant_id");
CREATE INDEX IF NOT EXISTS "status_posts_posted_at_idx" ON "status_posts" ("posted_at");
