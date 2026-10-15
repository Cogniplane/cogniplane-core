CREATE TABLE organization_skill_submissions (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  author_user_id text NOT NULL,
  source_skill_id text NOT NULL,
  target_skill_id text,
  accepted_skill_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','changes_requested','declined','withdrawn','accepted')),
  latest_attempt integer NOT NULL DEFAULT 1 CHECK (latest_attempt > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, submission_id),
  CHECK (accepted_skill_id IS NULL OR status = 'accepted'),
  CHECK (target_skill_id IS NULL OR target_skill_id <> '')
);

CREATE TABLE organization_skill_submission_attempts (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('pending','changes_requested','declined','withdrawn','accepted')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  source_revision integer NOT NULL CHECK (source_revision > 0),
  source_name text NOT NULL,
  source_description text NOT NULL,
  source_instructions text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  validation_messages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(validation_messages) = 'array'),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  feedback text CHECK (feedback IS NULL OR length(feedback) <= 4000),
  accepted_revision_id bigint,
  PRIMARY KEY (tenant_id, submission_id, attempt),
  FOREIGN KEY (tenant_id, submission_id) REFERENCES organization_skill_submissions(tenant_id, submission_id) ON DELETE CASCADE,
  CHECK (source_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(source_name) <= 64),
  CHECK (length(source_description) BETWEEN 1 AND 1024),
  CHECK (length(source_instructions) BETWEEN 1 AND 64000)
);

CREATE INDEX organization_skill_submissions_author_idx
  ON organization_skill_submissions(tenant_id, author_user_id, updated_at DESC);
CREATE INDEX organization_skill_submissions_review_idx
  ON organization_skill_submissions(tenant_id, status, updated_at DESC);
CREATE UNIQUE INDEX organization_skill_submissions_one_pending_source_idx
  ON organization_skill_submissions(tenant_id, author_user_id, source_skill_id)
  WHERE status IN ('pending','changes_requested');

ALTER TABLE organization_skill_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_skill_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_skill_submissions
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
ALTER TABLE organization_skill_submission_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_skill_submission_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_skill_submission_attempts
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
