ALTER TABLE agent_tasks
  ADD COLUMN action_token_hash TEXT,
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN resolved_by TEXT;

CREATE UNIQUE INDEX agent_tasks_token_hash_idx
  ON agent_tasks (action_token_hash)
  WHERE action_token_hash IS NOT NULL;
