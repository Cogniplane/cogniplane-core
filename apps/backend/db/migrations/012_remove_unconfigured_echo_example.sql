-- Only remove the unchanged system example. Configured or tenant-owned
-- resources remain, including installations that reused the example ID.
DELETE FROM admin_mcp_servers
WHERE tenant_id = 'system'
  AND server_id = 'trusted-echo'
  AND server_name = 'Trusted echo'
  AND description = 'Forward validated framework context to a trusted upstream MCP server.'
  AND transport_kind = 'http'
  AND mode = 'proxy'
  AND route_path = '/mcp/trusted-echo'
  AND upstream_url IS NULL
  AND headers_allowlist = '["X-Framework-User-Id","X-Framework-Session-Id","X-Framework-Runtime-Id"]'::jsonb
  AND version = 1
  AND config_hash = md5('trusted-echo:v1')
  AND enabled = FALSE
  AND created_by = 'system'
  AND is_published = TRUE;
