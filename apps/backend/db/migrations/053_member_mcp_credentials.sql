ALTER TABLE admin_mcp_servers
  ADD COLUMN credential_scope text NOT NULL DEFAULT 'organization'
    CHECK (credential_scope IN ('organization', 'personal')),
  ADD COLUMN credential_binding_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE admin_mcp_servers DROP CONSTRAINT admin_mcp_servers_upstream_auth_shape_check;
ALTER TABLE admin_mcp_servers ADD CONSTRAINT admin_mcp_servers_upstream_auth_shape_check CHECK (
  (upstream_auth_type = 'none' AND upstream_auth_name IS NULL AND upstream_auth_secret_encrypted IS NULL)
  OR (upstream_auth_type = 'bearer' AND upstream_auth_name IS NULL AND (
    (credential_scope = 'personal' AND upstream_auth_secret_encrypted IS NULL)
    OR (credential_scope = 'organization' AND upstream_auth_secret_encrypted IS NOT NULL)
  ))
  OR (upstream_auth_type IN ('header', 'query') AND upstream_auth_name IS NOT NULL AND (
    (credential_scope = 'personal' AND upstream_auth_secret_encrypted IS NULL)
    OR (credential_scope = 'organization' AND upstream_auth_secret_encrypted IS NOT NULL)
  ))
);
ALTER TABLE admin_mcp_servers ADD CONSTRAINT admin_mcp_servers_personal_scope_check CHECK (
  credential_scope <> 'personal' OR (mode = 'proxy' AND upstream_auth_type <> 'none')
);
UPDATE admin_mcp_servers
  SET config_hash = md5(config_hash || ':' || credential_scope || ':' || credential_binding_id::text);

CREATE TABLE member_mcp_credentials (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  server_id text NOT NULL,
  credential_binding_id uuid NOT NULL,
  secret_encrypted text,
  account_label text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, server_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
  CHECK (account_label IS NULL OR length(account_label) <= 120)
);
CREATE INDEX member_mcp_credentials_owner_idx ON member_mcp_credentials (tenant_id, user_id);

ALTER TABLE member_mcp_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_mcp_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_mcp_credentials
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
