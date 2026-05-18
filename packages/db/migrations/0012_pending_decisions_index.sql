-- F-4: Persist pending merchant decisions in agent_tasks so they outlive Redis TTL.
--
-- Partial unique index: at most one OPEN row of each pending-decision type per merchant.
-- Restricted to the new types so the existing ONBOARDING_FOLLOWUP behavior (which may
-- have multiple rows per merchant) is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_pending_decision_unique_idx
  ON agent_tasks (merchant_id, type)
  WHERE status = 'OPEN'
    AND type IN ('PENDING_ORDER_CONFIRMATION', 'PENDING_PAYMENT_REVIEW');

-- Index for cron scans of OPEN agent tasks by age.
CREATE INDEX IF NOT EXISTS agent_tasks_status_created_at_idx
  ON agent_tasks (status, created_at);
