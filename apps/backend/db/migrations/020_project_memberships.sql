ALTER TABLE projects ADD COLUMN visibility text NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'organization'));
ALTER TABLE projects ADD COLUMN organization_role text NOT NULL DEFAULT 'viewer'
  CHECK (organization_role IN ('viewer', 'editor'));

CREATE TABLE project_memberships (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(user_id),
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, user_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id)
);
ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY project_memberships_tenant_isolation ON project_memberships
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE INDEX project_memberships_user ON project_memberships (tenant_id, user_id, project_id);

-- Preserve creator ownership for existing projects. Access still requires current
-- organization membership, so this does not admit former organization members.
INSERT INTO project_memberships (tenant_id, project_id, user_id, role)
  SELECT tenant_id, project_id, user_id, 'owner' FROM projects;

ALTER TABLE sessions DROP CONSTRAINT sessions_project_owner_fk;
ALTER TABLE sessions ADD CONSTRAINT sessions_project_tenant_fk
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, project_id);

CREATE INDEX sessions_project_tenant ON sessions (tenant_id, project_id)
  WHERE project_id IS NOT NULL;
