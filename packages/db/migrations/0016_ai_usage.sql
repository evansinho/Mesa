-- F-10: Per-call audit trail for AI usage (NLP + OCR) for cost dashboards
-- and quota reconciliation.

CREATE TABLE IF NOT EXISTS ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  model text NOT NULL,
  cost_usd_micros integer NOT NULL,
  input_tokens integer,
  output_tokens integer,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_merchant_idx ON ai_usage (merchant_id);
CREATE INDEX IF NOT EXISTS ai_usage_merchant_date_idx ON ai_usage (merchant_id, created_at);
