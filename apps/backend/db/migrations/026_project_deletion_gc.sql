-- Project deletion keeps storage cleanup durable after the project row is gone.
-- The cleanup table must outlive the project that created its entries.
DO $$
DECLARE fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'public.project_file_storage_gc'::regclass
    AND confrelid = 'public.projects'::regclass
    AND contype = 'f';
  IF fk_name IS NULL THEN
    RAISE EXCEPTION 'Expected project_file_storage_gc project foreign key is missing';
  END IF;
  EXECUTE format('ALTER TABLE public.project_file_storage_gc DROP CONSTRAINT %I', fk_name);
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.project_file_storage_gc'::regclass
      AND confrelid = 'public.projects'::regclass
      AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'project_file_storage_gc project foreign key was not removed';
  END IF;
END $$;

-- Runtime cleanup must outlive both the project and its sessions. The route
-- attempts cleanup immediately, while the scheduler retries rows left behind
-- by a failed runtime abort or checkpointer purge.
CREATE TABLE project_runtime_gc (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  project_id text NOT NULL,
  session_id text NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  last_error text,
  PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX project_runtime_gc_pending ON project_runtime_gc (next_attempt_at, created_at);

ALTER TABLE project_runtime_gc ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_runtime_gc FORCE ROW LEVEL SECURITY;
CREATE POLICY project_runtime_gc_tenant_isolation ON project_runtime_gc
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
