ALTER TABLE admin_mcp_servers
  ADD COLUMN upstream_auth_type text NOT NULL DEFAULT 'none'
    CHECK (upstream_auth_type IN ('none', 'bearer', 'header', 'query')),
  ADD COLUMN upstream_auth_name text,
  ADD COLUMN upstream_auth_secret_encrypted text;

ALTER TABLE admin_mcp_servers
  ADD CONSTRAINT admin_mcp_servers_upstream_auth_shape_check CHECK (
    (upstream_auth_type = 'none'
      AND upstream_auth_name IS NULL
      AND upstream_auth_secret_encrypted IS NULL)
    OR
    (upstream_auth_type = 'bearer'
      AND upstream_auth_name IS NULL
      AND upstream_auth_secret_encrypted IS NOT NULL)
    OR
    (upstream_auth_type IN ('header', 'query')
      AND upstream_auth_name IS NOT NULL
      AND upstream_auth_secret_encrypted IS NOT NULL)
  );
