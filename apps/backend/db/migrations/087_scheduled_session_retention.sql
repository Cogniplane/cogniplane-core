-- Scheduled session retention (SessionStore.cleanupExpiredScheduled) reads the
-- oldest active scheduled sessions first, so it does not scan every session.
CREATE INDEX IF NOT EXISTS sessions_scheduled_retention_idx
  ON sessions (created_at, session_id)
  WHERE purpose = 'scheduled' AND status = 'active';

-- The retention check reads the runs of a session. Each session delete also
-- sets their session_id to NULL (scheduled_job_runs_tenant_session_fkey).
-- Without this index, both scan the whole run history.
CREATE INDEX IF NOT EXISTS scheduled_job_runs_session_idx
  ON scheduled_job_runs (tenant_id, session_id);
