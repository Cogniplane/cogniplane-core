CREATE TABLE admin_mcp_connection_tests (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  server_id text NOT NULL,
  scope_user_id text NOT NULL DEFAULT '',
  owner_tenant_id text NOT NULL,
  config_hash text NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  config_version integer NOT NULL CHECK (config_version > 0),
  credential_binding_id text,
  credential_version integer,
  started_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL,
  reachability text NOT NULL CHECK (reachability IN ('reachable','unreachable','unknown')),
  authentication text NOT NULL CHECK (authentication IN ('accepted','not_required','indeterminate','credential_missing')),
  tool_discovery text NOT NULL CHECK (tool_discovery IN ('succeeded','partial','failed','not_tested')),
  tool_count integer CHECK (tool_count IS NULL OR tool_count >= 0),
  message text NOT NULL CHECK (length(message) <= 300),
  PRIMARY KEY (tenant_id, server_id, scope_user_id),
  CHECK ((scope_user_id = '') = (credential_binding_id IS NULL AND credential_version IS NULL))
);

ALTER TABLE admin_mcp_connection_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_mcp_connection_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_mcp_connection_tests
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
