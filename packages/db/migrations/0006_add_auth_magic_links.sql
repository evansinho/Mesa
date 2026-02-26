CREATE TABLE IF NOT EXISTS "auth_magic_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id"),
  "token_hash" text NOT NULL,
  "expires_at" timestamp without time zone NOT NULL,
  "used_at" timestamp without time zone,
  "created_at" timestamp without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "auth_magic_links_merchant_idx" ON "auth_magic_links"("merchant_id");
CREATE INDEX IF NOT EXISTS "auth_magic_links_token_idx" ON "auth_magic_links"("token_hash");

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id"),
  "session_hash" text NOT NULL,
  "expires_at" timestamp without time zone NOT NULL,
  "created_at" timestamp without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "auth_sessions_merchant_idx" ON "auth_sessions"("merchant_id");
CREATE INDEX IF NOT EXISTS "auth_sessions_session_idx" ON "auth_sessions"("session_hash");
