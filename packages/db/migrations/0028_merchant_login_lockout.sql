ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "failed_login_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "login_locked_until" timestamp;
