ALTER TABLE session_executions
  ADD COLUMN owner_id text,
  ADD COLUMN heartbeat_at timestamptz;

CREATE INDEX session_executions_live_owner_idx
  ON session_executions (tenant_id, owner_id, expires_at)
  WHERE status = 'active';
