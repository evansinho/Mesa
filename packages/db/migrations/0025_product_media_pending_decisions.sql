DROP INDEX IF EXISTS agent_tasks_pending_decision_unique_idx;

CREATE UNIQUE INDEX agent_tasks_pending_decision_unique_idx
  ON agent_tasks (merchant_id, type)
  WHERE status = 'OPEN'
    AND type IN (
      'PENDING_ORDER_CONFIRMATION',
      'PENDING_PAYMENT_REVIEW',
      'PENDING_FULFILMENT_DECISION',
      'PENDING_PRODUCT_MEDIA_CONFIRMATION'
    );
