-- Repositories that the agent may use through one member's GitHub connection.
--
-- The OAuth token has the broad `repo` scope, so Cogniplane narrows what the
-- agent can reach. Each entry is `owner/name` in lower case; the application
-- validates and normalizes it before it writes. An empty list means the agent
-- can use no repository. Every existing connection starts with an empty list
-- on purpose: the member chooses repositories on the GitHub settings page.
-- The managed GitHub tools tell the member to do this when they are denied.
--
-- The column is on the connection row, so the existing tenant_isolation policy
-- (ENABLE and FORCE ROW LEVEL SECURITY, keyed on tenant_id) covers it.
-- migrate.ts reapplies the table GRANTs after every run.
ALTER TABLE user_github_connections
  ADD COLUMN allowed_repositories text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT user_github_connections_allowed_repositories_limit
    CHECK (cardinality(allowed_repositories) <= 200);
