-- Claim project-file storage cleanup rows before touching external storage.
-- This keeps multiple workers from deleting the same object and lets a failed
-- delete move out of the head of the queue until its backoff expires.
ALTER TABLE project_file_storage_gc
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_error text;

DROP INDEX IF EXISTS project_file_storage_gc_pending;
CREATE INDEX project_file_storage_gc_pending
  ON project_file_storage_gc (next_attempt_at, created_at, tenant_id, project_id, storage_key);
