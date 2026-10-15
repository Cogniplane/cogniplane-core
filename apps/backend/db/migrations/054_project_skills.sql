-- Project-owned, instruction-only skills. Author and source user IDs are
-- attribution only: a departed member does not remove project content.
CREATE TABLE project_skills (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  project_id text NOT NULL,
  skill_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  latest_revision integer NOT NULL DEFAULT 1 CHECK (latest_revision > 0),
  active_revision integer,
  enabled boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  source_user_id text,
  source_skill_id text,
  source_revision integer CHECK (source_revision IS NULL OR source_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, skill_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id) ON DELETE CASCADE,
  CHECK (skill_id ~ '^project-skill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CHECK (active_revision IS NULL OR active_revision <= latest_revision),
  CHECK (NOT enabled OR active_revision IS NOT NULL),
  CHECK ((source_user_id IS NULL) = (source_skill_id IS NULL)),
  CHECK ((source_user_id IS NULL) = (source_revision IS NULL)),
  CHECK (source_skill_id IS NULL OR
    source_skill_id ~ '^personal-skill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

CREATE TABLE project_skill_revisions (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  project_id text NOT NULL,
  skill_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  validation_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  -- Set only when this revision is a copy of a released personal revision.
  source_revision integer CHECK (source_revision IS NULL OR source_revision > 0),
  source_content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, skill_id, revision),
  FOREIGN KEY (tenant_id, project_id, skill_id)
    REFERENCES project_skills(tenant_id, project_id, skill_id) ON DELETE CASCADE,
  CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
  CHECK (length(description) BETWEEN 1 AND 1024),
  CHECK (length(instructions) BETWEEN 1 AND 64000),
  CHECK (jsonb_typeof(validation_messages) = 'array'),
  CHECK ((source_revision IS NULL) = (source_content_hash IS NULL)),
  CHECK (source_content_hash IS NULL OR source_content_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX project_skills_project_updated_idx
  ON project_skills (tenant_id, project_id, updated_at DESC);

ALTER TABLE project_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_skills
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

ALTER TABLE project_skill_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_skill_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_skill_revisions
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
