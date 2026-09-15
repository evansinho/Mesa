ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "is_test_account" boolean DEFAULT false NOT NULL;
