ALTER TABLE "merchant_channels" DROP COLUMN IF EXISTS "page_id";
ALTER TABLE "merchant_channels" ADD COLUMN IF NOT EXISTS "token_refreshed_at" timestamp;
