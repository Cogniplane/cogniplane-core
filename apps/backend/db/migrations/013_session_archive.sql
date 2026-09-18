ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- The migration runner wraps this replacement and its validation in one transaction.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check
CHECK (status IN ('active', 'archived', 'deleted'));

CREATE INDEX IF NOT EXISTS sessions_archived_user_idx ON sessions (tenant_id, user_id, updated_at DESC)
WHERE status = 'archived';
