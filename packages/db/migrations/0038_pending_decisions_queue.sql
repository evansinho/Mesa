ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "surfaced_at" timestamptz;

-- Every currently in-flight item is already showing to a merchant — treat it
-- as "current" on deploy so nothing already on screen silently vanishes.
UPDATE "agent_tasks" SET "surfaced_at" = "created_at" WHERE "status" = 'OPEN' AND "surfaced_at" IS NULL;

-- Replaces the old (merchant_id, type) WHERE status='OPEN' constraint — that
-- forced at most one OPEN row per merchant+type, so a second customer's
-- pending item had nowhere to go but overwrite the first's. Scoping to
-- surfaced_at IS NOT NULL instead enforces "at most one CURRENT item at a
-- time" while leaving queued (surfaced_at IS NULL) items unconstrained.
DROP INDEX IF EXISTS agent_tasks_pending_decision_unique_idx;
CREATE UNIQUE INDEX agent_tasks_pending_decision_unique_idx
  ON agent_tasks (merchant_id, type)
  WHERE status = 'OPEN'
    AND surfaced_at IS NOT NULL
    AND type IN (
      'PENDING_ORDER_CONFIRMATION',
      'PENDING_PAYMENT_REVIEW',
      'PENDING_FULFILMENT_DECISION',
      'PENDING_PRODUCT_MEDIA_CONFIRMATION'
    );

-- Self-heal cron + promoteNext scan for the oldest queued row per
-- merchant+type — same shape as the existing status/created_at index.
CREATE INDEX IF NOT EXISTS agent_tasks_status_surfaced_at_idx
  ON agent_tasks (status, surfaced_at);
