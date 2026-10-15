CREATE TABLE personal_skills (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  skill_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  latest_revision integer NOT NULL DEFAULT 1 CHECK (latest_revision > 0),
  active_revision integer,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, skill_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
  CHECK (skill_id ~ '^personal-skill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CHECK (active_revision IS NULL OR active_revision <= latest_revision),
  CHECK (NOT enabled OR active_revision IS NOT NULL)
);

CREATE TABLE personal_skill_revisions (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  skill_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  validation_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, skill_id, revision),
  FOREIGN KEY (tenant_id, user_id, skill_id)
    REFERENCES personal_skills(tenant_id, user_id, skill_id) ON DELETE CASCADE,
  CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
  CHECK (length(description) BETWEEN 1 AND 1024),
  CHECK (length(instructions) BETWEEN 1 AND 64000),
  CHECK (jsonb_typeof(validation_messages) = 'array')
);

CREATE INDEX personal_skills_owner_updated_idx
  ON personal_skills (tenant_id, user_id, updated_at DESC);

ALTER TABLE personal_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON personal_skills
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

ALTER TABLE personal_skill_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_skill_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON personal_skill_revisions
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
