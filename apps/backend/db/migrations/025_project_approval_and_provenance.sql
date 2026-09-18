-- Automatic approval never had behavior distinct from organization_default.
-- Keep the organization gate authoritative and normalize rows written by the
-- old contract before tightening the check constraint.
UPDATE projects SET approval_mode = 'organization_default' WHERE approval_mode = 'automatic';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_approval_mode_check;
ALTER TABLE projects ADD CONSTRAINT projects_approval_mode_check
  CHECK (approval_mode IN ('organization_default', 'manual'));

ALTER TABLE project_files ADD COLUMN created_by_type text NOT NULL DEFAULT 'user'
  CHECK (created_by_type IN ('user', 'agent'));

-- Retention records object keys whose database rows were removed. Storage
-- deletion happens after commit, so a transient bucket failure can be retried.
CREATE TABLE project_file_storage_gc (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, storage_key),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id) ON DELETE CASCADE
);
CREATE INDEX project_file_storage_gc_pending ON project_file_storage_gc (created_at);

ALTER TABLE project_file_storage_gc ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_file_storage_gc FORCE ROW LEVEL SECURITY;
CREATE POLICY project_file_storage_gc_tenant_isolation ON project_file_storage_gc
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE INDEX project_files_retention_candidates ON project_files (updated_at, file_id)
  WHERE kind = 'promoted' OR trashed_at IS NOT NULL;
