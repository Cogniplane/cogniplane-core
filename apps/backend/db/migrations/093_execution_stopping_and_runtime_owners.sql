-- A stopped turn keeps its session busy until its owner has unwound it
-- (SessionExecutionStore.stopAndGetOwner sets 'stopping', the owner's release
-- sets 'stopped'). A 'stopping' row has no authority: every authority check
-- still requires 'active'. It ends at its expiry if the owner is gone.
ALTER TABLE session_executions DROP CONSTRAINT session_executions_status_check;
ALTER TABLE session_executions ADD CONSTRAINT session_executions_status_check
  CHECK (status IN ('active', 'stopping', 'stopped', 'finished'));

-- The busy predicate (sessionExecutionBusySql) and the lease sweep read both
-- live states. The older 'active'-only indexes stay for the authority checks.
CREATE INDEX IF NOT EXISTS session_executions_busy_project_idx
  ON session_executions (tenant_id, project_id)
  WHERE status IN ('active', 'stopping');
CREATE INDEX IF NOT EXISTS session_executions_busy_expiry_idx
  ON session_executions (expires_at)
  WHERE status IN ('active', 'stopping');

-- Each backend process stamps the runtime rows it creates and renews the stamp
-- while it runs (RuntimeSessionStore.heartbeatOwner). A row whose owner stopped
-- renewing it belongs to a process that is gone, and the sweep terminates it.
ALTER TABLE runtime_sessions
  ADD COLUMN owner_id text,
  ADD COLUMN owner_heartbeat_at timestamptz;
CREATE INDEX IF NOT EXISTS runtime_sessions_live_owner_idx
  ON runtime_sessions (owner_id, owner_heartbeat_at)
  WHERE status IN ('starting', 'active', 'terminating');
