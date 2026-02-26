CREATE TABLE IF NOT EXISTS "merchant_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "channel_account_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'connected',
  "connected_at" timestamp without time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "merchant_channels_merchant_idx" ON "merchant_channels"("merchant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_channels_channel_account_idx" ON "merchant_channels"("channel", "channel_account_id");
