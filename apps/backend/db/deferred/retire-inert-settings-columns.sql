-- Apply only after every backend writer runs the release that removed these
-- column references. This file is deliberately outside automatic migrations.
-- See docs/runbooks/retire-inert-settings-columns.md for rollout and rollback.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE admin_mcp_servers DROP COLUMN IF EXISTS headers_allowlist;
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS allow_user_token_forwarding;
COMMIT;
