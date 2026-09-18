CREATE TABLE IF NOT EXISTS projects (
  project_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  user_id text NOT NULL REFERENCES users(user_id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, project_id)
);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
-- RLS is tenant-scoped; stores also enforce user ownership. FORCE follows
-- the repository-wide tenant-table invariant. Maintenance connections need
-- BYPASSRLS or an explicit tenant scope when accessing rows.
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_tenant_isolation ON projects;
CREATE POLICY projects_tenant_isolation ON projects
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE INDEX IF NOT EXISTS projects_owner ON projects (tenant_id, user_id, updated_at DESC);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_project_owner_fk;
ALTER TABLE sessions ADD CONSTRAINT sessions_project_owner_fk
  FOREIGN KEY (tenant_id, user_id, project_id) REFERENCES projects (tenant_id, user_id, project_id);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions (tenant_id, user_id, project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_project_reference ON sessions (project_id) WHERE purpose = 'project_reference';
