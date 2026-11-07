-- Apply only after every backend writer runs the release that removed these
-- column references. This file is deliberately outside automatic migrations.
-- See docs/development.md, "Conventions" (deferred SQL). Rollback: restore
-- the columns from a backup; no released code reads them.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE admin_mcp_servers DROP COLUMN IF EXISTS headers_allowlist;
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS allow_user_token_forwarding;
COMMIT;
