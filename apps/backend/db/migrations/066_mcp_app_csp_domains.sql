-- Content security policy sources for MCP app widgets, approved per server.
--
-- A proxy server declares the domains that its widget needs. The declaration is
-- input from that server and sets no limit. An administrator approves each
-- source for one source list of one server, and a widget gets the declared
-- sources that were approved. Both tables start empty, so after this migration
-- no widget gets an outside domain until an administrator approves it.
--
-- server_id has no foreign key: a tenant also sees the built-in servers of the
-- 'system' tenant, and approves them for itself. The tenant owns every row.
--
-- The checks on source repeat the part of the application rules that matters if
-- the application is wrong: no space, quote, semicolon, comma, path, user name or
-- address in brackets can reach a policy through these tables. The parser in the
-- shared types package applies the full rules, including the public suffix list.

CREATE TABLE admin_mcp_app_csp_approvals (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  server_id text NOT NULL,
  directive text NOT NULL
    CHECK (directive IN ('resourceDomains', 'connectDomains', 'frameDomains', 'baseUriDomains')),
  source text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, server_id, directive, source),
  CONSTRAINT admin_mcp_app_csp_approvals_source_check CHECK (
    length(source) <= 300
    AND source ~ '^(https|wss)://(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?$'
    AND (directive = 'connectDomains' OR source LIKE 'https://%')
  )
);

-- What widgets declared when a member opened one. An administrator reads it to
-- decide what to approve. Only a source that passes the parser is recorded.
-- The application keeps the number of rows per server small.
CREATE TABLE admin_mcp_app_csp_requests (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  server_id text NOT NULL,
  directive text NOT NULL
    CHECK (directive IN ('resourceDomains', 'connectDomains', 'frameDomains', 'baseUriDomains')),
  source text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, server_id, directive, source),
  CONSTRAINT admin_mcp_app_csp_requests_source_check CHECK (
    length(source) <= 300
    AND source ~ '^(https|wss)://(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?$'
    AND (directive = 'connectDomains' OR source LIKE 'https://%')
  )
);

ALTER TABLE admin_mcp_app_csp_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_mcp_app_csp_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_mcp_app_csp_approvals
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

ALTER TABLE admin_mcp_app_csp_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_mcp_app_csp_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_mcp_app_csp_requests
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
