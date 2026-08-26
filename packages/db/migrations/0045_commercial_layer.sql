-- Commercial layer: internal sales/CS tooling.
-- Spec: idea/sales-lifecycle-spec.md
--
-- Entirely additive — touches no existing table. The commercial layer reads
-- merchant data but owns none of it, which is also enforced at the database
-- role level (the staff app connects read-only to merchant tables).
--
-- Note the deliberate omission: there is no `lifecycle_state` column anywhere.
-- Everything after signup is derived from merchants / merchant_channels /
-- orders / payments so a rep cannot move a merchant into "activated".

-- ─── Enums ───────────────────────────────────────────────────────────────────
-- CREATE TYPE has no IF NOT EXISTS in Postgres; the DO block is the standard
-- idempotent form and matches what drizzle-kit emits.

DO $$ BEGIN
  CREATE TYPE "staff_role" AS ENUM('admin', 'manager', 'member');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "prospect_stage" AS ENUM('SOURCED', 'CONTACTED', 'DEMOED', 'DISQUALIFIED', 'DORMANT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "disqualify_reason" AS ENUM('NOT_A_SELLER', 'NO_WHATSAPP_ORDERS', 'TOO_LARGE', 'PRICE', 'NO_RESPONSE', 'DUPLICATE', 'COMPETITOR', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "prospect_source" AS ENUM('outbound', 'referral', 'instagram', 'whatsapp', 'partnership', 'event', 'organic', 'inbound');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "prospect_match_status" AS ENUM('unmatched', 'auto', 'manual', 'ambiguous');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "staff_activity_type" AS ENUM('note', 'call', 'whatsapp', 'demo', 'meeting');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ─── staff ───────────────────────────────────────────────────────────────────
-- Internal users. No merchant_id: a staff member must never be reachable
-- through the merchant session path.

CREATE TABLE IF NOT EXISTS "staff" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "role" "staff_role" DEFAULT 'member' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "must_reset_password" boolean DEFAULT true NOT NULL,
  "ref_code" text,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_email_idx" ON "staff" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "staff_ref_code_idx" ON "staff" ("ref_code");

-- ─── staff_sessions ──────────────────────────────────────────────────────────
-- Separate from auth_sessions on purpose. Staff sessions cross the merchant
-- tenancy boundary by design, so a bug in merchant session handling must not
-- be able to mint one. ON DELETE CASCADE is what makes deactivation-by-delete
-- revoke access immediately rather than at token expiry.

CREATE TABLE IF NOT EXISTS "staff_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE CASCADE,
  "session_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "staff_sessions_staff_idx" ON "staff_sessions" ("staff_id");
CREATE UNIQUE INDEX IF NOT EXISTS "staff_sessions_session_idx" ON "staff_sessions" ("session_hash");

-- ─── prospects ───────────────────────────────────────────────────────────────
-- Pre-signup records. `stage` is human-owned and only meaningful while
-- merchant_id IS NULL; once matched, lifecycle state is derived instead.

CREATE TABLE IF NOT EXISTS "prospects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_name" text NOT NULL,
  "phone" text NOT NULL,
  "phone_normalized" text NOT NULL,
  "instagram_handle" text,
  "contact_name" text,
  "stage" "prospect_stage" DEFAULT 'SOURCED' NOT NULL,
  "disqualify_reason" "disqualify_reason",
  "disqualify_note" text,
  "source" "prospect_source" NOT NULL,
  "source_detail" text,
  "owner_id" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
  "merchant_id" uuid REFERENCES "merchants"("id") ON DELETE SET NULL,
  "match_status" "prospect_match_status" DEFAULT 'unmatched' NOT NULL,
  "matched_at" timestamp with time zone,
  "unlinked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- The join key for prospect → merchant matching on signup. Non-unique: two
-- reps can independently source the same business, which is exactly the
-- 'ambiguous' case that must never auto-match.
CREATE INDEX IF NOT EXISTS "prospects_phone_normalized_idx" ON "prospects" ("phone_normalized");
CREATE INDEX IF NOT EXISTS "prospects_owner_idx" ON "prospects" ("owner_id");
CREATE INDEX IF NOT EXISTS "prospects_stage_idx" ON "prospects" ("stage");

-- One prospect per merchant. Partial so the many unmatched rows don't collide
-- on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "prospects_merchant_idx"
  ON "prospects" ("merchant_id")
  WHERE "merchant_id" IS NOT NULL;

-- ─── prospect_activities ─────────────────────────────────────────────────────
-- Append-only. Also the input to escalation: escalation measures logged
-- activity, never merchant outcome (spec §7).

CREATE TABLE IF NOT EXISTS "prospect_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "prospect_id" uuid NOT NULL REFERENCES "prospects"("id") ON DELETE CASCADE,
  "staff_id" uuid NOT NULL REFERENCES "staff"("id"),
  "type" "staff_activity_type" DEFAULT 'note' NOT NULL,
  "body" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "prospect_activities_prospect_idx"
  ON "prospect_activities" ("prospect_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "prospect_activities_staff_idx"
  ON "prospect_activities" ("staff_id", "occurred_at");

-- ─── staff_audit_log ─────────────────────────────────────────────────────────
-- This app reads across every merchant by design, so reads are auditable here,
-- not just writes. staff_id is nullable + SET NULL so deleting a staff member
-- never destroys the audit trail.

CREATE TABLE IF NOT EXISTS "staff_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "staff_audit_log_staff_idx" ON "staff_audit_log" ("staff_id", "at");
CREATE INDEX IF NOT EXISTS "staff_audit_log_action_idx" ON "staff_audit_log" ("action", "at");
