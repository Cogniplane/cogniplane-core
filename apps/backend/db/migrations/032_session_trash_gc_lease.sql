-- Add retry and lease state for installations that already applied 030.
ALTER TABLE session_storage_gc
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_error text;

DROP INDEX IF EXISTS session_storage_gc_pending;
CREATE INDEX session_storage_gc_pending
  ON session_storage_gc (next_attempt_at, created_at, tenant_id, session_id);
