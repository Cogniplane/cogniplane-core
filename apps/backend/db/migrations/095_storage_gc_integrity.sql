-- Keep object storage and its database pointers in step (issue #117).
--
-- Skill revision cleanup deletes a revision row, then its bundle. The bundle
-- URI now goes into this queue in the same transaction as the row delete, so
-- a failed or interrupted bundle delete keeps the URI for a retry
-- (services/storage/storage-gc.ts). Tenant deletion copies the queue before
-- the cascade removes it.
CREATE TABLE skill_bundle_storage_gc (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  storage_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  last_error text,
  PRIMARY KEY (tenant_id, storage_uri)
);
CREATE INDEX skill_bundle_storage_gc_pending
  ON skill_bundle_storage_gc (next_attempt_at, created_at, tenant_id, storage_uri);

ALTER TABLE skill_bundle_storage_gc ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_bundle_storage_gc FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_bundle_storage_gc_tenant_isolation ON skill_bundle_storage_gc
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- A PII rejection (a block, or a permanent scan error) gives up the object of
-- the artifact: the row stays for its verdict and audit trail, but it is no
-- longer a reference that keeps the object. The same transaction queues the
-- key in session_storage_gc. Nullable without a default: no table rewrite.
ALTER TABLE artifacts ADD COLUMN storage_released_at timestamptz;

-- The bundle reference check reads every tenant by URI.
CREATE INDEX IF NOT EXISTS admin_skill_revisions_bundle_storage_uri_idx
  ON admin_skill_revisions (bundle_storage_uri)
  WHERE bundle_storage_uri IS NOT NULL;

-- Revision cleanup keeps a revision that an accepted member submission names.
CREATE INDEX IF NOT EXISTS organization_skill_submission_attempts_accepted_revision_idx
  ON organization_skill_submission_attempts (tenant_id, accepted_revision_id)
  WHERE accepted_revision_id IS NOT NULL;
