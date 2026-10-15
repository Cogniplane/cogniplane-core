-- Jira connection lifecycle. Pipedream labels a member's accounts with an
-- external user ID. Each disconnect or member removal retires that ID and
-- records a cleanup. The next authorization gets a new ID, so a retry of the
-- old cleanup cannot delete accounts that the member authorized later.

-- One row per tenant member who started a Jira authorization. The row stays
-- after membership removal, so that the generation is not reused when the
-- member is added again. `pipedream_external_user_id` is NULL after the
-- current ID is retired; the backend derives the next one from `generation`.
CREATE TABLE user_jira_identities (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  pipedream_external_user_id text CHECK (length(pipedream_external_user_id) BETWEEN 1 AND 128),
  -- Where the current external ID was used. NULL only for rows backfilled
  -- from migration 060 data, until the backend next uses them.
  pipedream_project_id text CHECK (length(pipedream_project_id) <= 128),
  pipedream_environment text CHECK (pipedream_environment IN ('development', 'production')),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id)
);

-- Remote cleanup that is not complete yet. A row is deleted only after every
-- Pipedream Jira account of the retired external ID is gone. No token is
-- stored here.
CREATE TABLE user_jira_cleanups (
  cleanup_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  -- No foreign key: the row must outlive the membership and the user.
  user_id text NOT NULL,
  pipedream_external_user_id text NOT NULL CHECK (length(pipedream_external_user_id) BETWEEN 1 AND 128),
  -- The selected account at retirement, if any. Other accounts of the
  -- external ID are found by listing.
  pipedream_account_id text CHECK (pipedream_account_id ~ '^apn_[A-Za-z0-9]+$'),
  pipedream_project_id text CHECK (length(pipedream_project_id) <= 128),
  pipedream_environment text CHECK (pipedream_environment IN ('development', 'production')),
  reason text NOT NULL CHECK (reason IN ('user_disconnect', 'member_removed', 'project_changed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX user_jira_cleanups_member_idx ON user_jira_cleanups (tenant_id, user_id);

ALTER TABLE user_jira_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_jira_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_jira_identities
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

ALTER TABLE user_jira_cleanups ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_jira_cleanups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_jira_cleanups
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Migration 060 data. Mappings of members who are already gone become
-- pending cleanups, and the member gets a retired identity at generation 1.
-- Without it, a re-added member would get generation 0 again, which is the
-- retired external ID, and the old cleanup would delete the new accounts.
-- The other mappings get an identity row with their stored external ID.
INSERT INTO user_jira_cleanups (tenant_id, user_id, pipedream_external_user_id, pipedream_account_id, reason)
SELECT c.tenant_id, c.user_id, c.pipedream_external_user_id, c.pipedream_account_id, 'member_removed'
FROM user_jira_connections c
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = c.tenant_id AND m.user_id = c.user_id
);
INSERT INTO user_jira_identities (tenant_id, user_id, generation, pipedream_external_user_id)
SELECT c.tenant_id, c.user_id, 1, NULL
FROM user_jira_connections c
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = c.tenant_id AND m.user_id = c.user_id
);
DELETE FROM user_jira_connections c
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = c.tenant_id AND m.user_id = c.user_id
);
INSERT INTO user_jira_identities (tenant_id, user_id, generation, pipedream_external_user_id)
SELECT tenant_id, user_id, 0, pipedream_external_user_id FROM user_jira_connections;

-- A mapping can exist only for a current member. The key check also makes a
-- concurrent selection wait for, or fail after, a membership removal.
ALTER TABLE user_jira_connections
  ADD CONSTRAINT user_jira_connections_membership_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE;

-- Member removal retires the Jira identity in the same transaction as the
-- membership delete: it records the cleanup, removes the active mapping, and
-- forces a new external ID. Remote deletion runs later and can fail without
-- undoing this. BEFORE DELETE runs before the cascade removes the mapping, so
-- the selected account ID is still readable. During tenant deletion the
-- tenant row is already gone and the cascade removes everything, so the
-- function does nothing.
CREATE FUNCTION retire_departed_member_jira() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE tenant_id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  INSERT INTO user_jira_cleanups (
    tenant_id, user_id, pipedream_external_user_id, pipedream_account_id,
    pipedream_project_id, pipedream_environment, reason
  )
  SELECT OLD.tenant_id, OLD.user_id,
    COALESCE(i.pipedream_external_user_id, c.pipedream_external_user_id),
    c.pipedream_account_id, i.pipedream_project_id, i.pipedream_environment, 'member_removed'
  FROM (SELECT 1) AS member
  LEFT JOIN user_jira_identities i ON i.tenant_id = OLD.tenant_id AND i.user_id = OLD.user_id
  LEFT JOIN user_jira_connections c ON c.tenant_id = OLD.tenant_id AND c.user_id = OLD.user_id
  WHERE COALESCE(i.pipedream_external_user_id, c.pipedream_external_user_id) IS NOT NULL;
  DELETE FROM user_jira_connections WHERE tenant_id = OLD.tenant_id AND user_id = OLD.user_id;
  UPDATE user_jira_identities
    SET generation = generation + 1, pipedream_external_user_id = NULL, updated_at = NOW()
    WHERE tenant_id = OLD.tenant_id AND user_id = OLD.user_id AND pipedream_external_user_id IS NOT NULL;
  RETURN OLD;
END;
$$;
CREATE TRIGGER tenant_membership_jira_retirement BEFORE DELETE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION retire_departed_member_jira();
