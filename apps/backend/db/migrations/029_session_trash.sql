ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS sessions_deleted_at_idx
  ON sessions (deleted_at, session_id)
  WHERE status = 'deleted' AND deleted_at IS NOT NULL;
