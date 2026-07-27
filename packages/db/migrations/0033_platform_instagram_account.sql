CREATE TABLE IF NOT EXISTS "platform_instagram_account" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" text NOT NULL,
  "username" text,
  "access_token" text NOT NULL,
  "token_refreshed_at" timestamp NOT NULL,
  "connected_at" timestamp DEFAULT now() NOT NULL
);
