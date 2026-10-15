-- Personal Jira connection held by Pipedream Connect. Pipedream stores the
-- Atlassian tokens; this row only binds one verified Pipedream account and one
-- Jira site to a tenant member. No provider token is stored here.
CREATE TABLE user_jira_connections (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- Derived on the server from tenant and user. Kept so that status, tool
  -- calls, and disconnect use the identity that was verified at selection.
  pipedream_external_user_id text NOT NULL CHECK (length(pipedream_external_user_id) BETWEEN 1 AND 128),
  pipedream_account_id text NOT NULL CHECK (pipedream_account_id ~ '^apn_[A-Za-z0-9]+$'),
  account_name text CHECK (account_name IS NULL OR length(account_name) <= 300),
  jira_cloud_id uuid NOT NULL,
  jira_site_name text NOT NULL CHECK (length(jira_site_name) <= 300),
  jira_site_url text NOT NULL CHECK (length(jira_site_url) <= 2048),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE user_jira_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_jira_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_jira_connections
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
