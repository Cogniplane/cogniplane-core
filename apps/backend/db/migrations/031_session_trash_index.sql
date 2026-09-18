-- 029 creates this index with the same key order on fresh installs. This
-- follow-up also repairs databases that already applied the earlier version.
DROP INDEX IF EXISTS sessions_deleted_at_idx;
CREATE INDEX sessions_deleted_at_idx
  ON sessions (deleted_at, session_id)
  WHERE status = 'deleted' AND deleted_at IS NOT NULL;

-- The sidebar derives active-turn state from this table for every listed
-- session. Keep the status-filtered lookup narrow on installations that do
-- not already have a matching composite index.
CREATE INDEX IF NOT EXISTS session_executions_active_session_idx
  ON session_executions (tenant_id, session_id, started_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS audit_events_project_activity_idx
  ON audit_events (tenant_id, event_type, created_at DESC, id DESC);
