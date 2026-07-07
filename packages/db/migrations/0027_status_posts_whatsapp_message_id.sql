ALTER TABLE "status_posts" ADD COLUMN IF NOT EXISTS "whatsapp_message_id" text;
CREATE INDEX IF NOT EXISTS "status_posts_whatsapp_message_idx" ON "status_posts" ("whatsapp_message_id");
