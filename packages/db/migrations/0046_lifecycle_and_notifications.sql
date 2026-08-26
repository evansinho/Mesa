-- Commercial layer, part two: derived lifecycle + staff notifications.
-- Spec: idea/sales-lifecycle-spec.md §4, §7
--
-- Additive. Note what is NOT here: no `lifecycle_state` column on merchants.
-- Current state is a query over merchants / merchant_channels / orders /
-- payments; only transitions are stored, so there is nothing for a rep to
-- hand-edit and nothing to drift out of sync with the product.

DO $$ BEGIN
  CREATE TYPE "lifecycle_state" AS ENUM(
    'SIGNED_UP', 'CONNECTED', 'FIRST_VALUE', 'FIRST_PAYMENT',
    'ACTIVATED', 'PAYING', 'AT_RISK', 'CHURNED'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "staff_notification_tier" AS ENUM('action', 'feed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "staff_notification_kind" AS ENUM(
    'SIGNUP_UNOWNED', 'NOT_CONNECTED', 'NO_FIRST_ORDER', 'TRIAL_ENDING_NO_VALUE',
    'AT_RISK', 'PAST_DUE', 'PROSPECT_STALE', 'ESCALATION',
    'FIRST_VALUE', 'ACTIVATED', 'RECOVERED'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ─── merchant_lifecycle_events ───────────────────────────────────────────────
-- Append-only. Current state is derivable at any time; WHEN a merchant moved
-- is not, and every time-based metric the CCO needs is a question about when.

CREATE TABLE IF NOT EXISTS "merchant_lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "from_state" "lifecycle_state",
  "to_state" "lifecycle_state" NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "rule_version" integer NOT NULL,
  "detected_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "merchant_lifecycle_events_merchant_idx"
  ON "merchant_lifecycle_events" ("merchant_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "merchant_lifecycle_events_to_state_idx"
  ON "merchant_lifecycle_events" ("to_state", "occurred_at");

-- No unique index on (merchant_id, to_state, rule_version) on purpose. It
-- would make the sweep trivially idempotent, but it would also throw away
-- genuine re-entry, and AT_RISK -> PAYING -> AT_RISK is exactly the cycle the
-- recovery-rate metric is made of. The sweep instead compares each merchant's
-- derived state against their latest recorded one: unchanged appends nothing,
-- a real re-entry appends a row.

-- ─── staff_notifications ─────────────────────────────────────────────────────
-- Stateful and re-evaluated. Every trigger has an inverse and the sweep
-- resolves rows whose condition no longer holds, so a merchant who connects on
-- Wednesday closes Tuesday's notification with nobody touching it.

CREATE TABLE IF NOT EXISTS "staff_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE CASCADE,
  "tier" "staff_notification_tier" NOT NULL,
  "kind" "staff_notification_kind" NOT NULL,
  "merchant_id" uuid REFERENCES "merchants"("id") ON DELETE CASCADE,
  "prospect_id" uuid REFERENCES "prospects"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "read_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "escalated_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "staff_notifications_inbox_idx"
  ON "staff_notifications" ("staff_id", "resolved_at", "created_at");

-- These two partial indexes are what stop a 15-minute sweep opening the same
-- notification 96 times a day. Two rather than one because a notification
-- targets either a merchant or a prospect and a unique index does not dedupe
-- NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS "staff_notifications_open_merchant_idx"
  ON "staff_notifications" ("staff_id", "kind", "merchant_id")
  WHERE "resolved_at" IS NULL AND "merchant_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "staff_notifications_open_prospect_idx"
  ON "staff_notifications" ("staff_id", "kind", "prospect_id")
  WHERE "resolved_at" IS NULL AND "prospect_id" IS NOT NULL;
