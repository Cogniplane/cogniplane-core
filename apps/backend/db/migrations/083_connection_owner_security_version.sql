-- A personal connection acts as its owner: the agent uses the connected
-- GitHub, Notion, Jira or Microsoft account, or the saved MCP credential.
-- A session that a stolen access token opened can attach the attacker's own
-- account or secret. That connection must stop when the owner changes the
-- password or signs out everywhere. Each connection therefore keeps the
-- security version of the owner's local account from the session that saved
-- it (connect, Jira site selection, MCP credential save, or a confirm). Every
-- read for use compares it with local_identities.security_version and does
-- not return the connection on a difference: the connection is suspended.
-- The owner sees it as suspended and confirms it or connects again from a
-- current session, which stores the new version. A suspended connection is
-- not deleted. See ownerSecurityVersionSql in services/auth/security-change.ts.
--
-- NULL owner_security_version: for a WorkOS owner, the connection is not
-- compared. WorkOS accounts have no security version in this database. For a
-- local owner, NULL is a mismatch, so the connection is suspended.
--
-- IF NOT EXISTS and the `owner_security_version IS NULL` conditions below:
-- an earlier build of this change applied the same columns as migration 081
-- to some development databases. There this file adds nothing and keeps the
-- versions that the backend already stored. On every other database the
-- columns are new and all NULL, so the conditions change nothing.
ALTER TABLE user_github_connections ADD COLUMN IF NOT EXISTS owner_security_version integer;
ALTER TABLE user_notion_connections ADD COLUMN IF NOT EXISTS owner_security_version integer;
ALTER TABLE user_microsoft_connections ADD COLUMN IF NOT EXISTS owner_security_version integer;
ALTER TABLE user_jira_connections ADD COLUMN IF NOT EXISTS owner_security_version integer;
ALTER TABLE member_mcp_credentials ADD COLUMN IF NOT EXISTS owner_security_version integer;

-- Existing connections of local owners. Keep the current version only on a
-- connection that a session saved after the owner's last security change.
-- Every security_version increment sets local_identities.updated_at = now(),
-- and no other write sets that column, so it is the time of the last change
-- (see migration 080). Every other connection of a local owner stays NULL and
-- is suspended until the owner confirms it.
--
-- The updated_at columns of the OAuth tables are not save times: each token
-- refresh and each use sets them. created_at is the first save; a reconnect
-- keeps it. A later save is a reconnect, which writes the audit event
-- `user.<provider>.connected`.
--
-- OAuth margin: 11 minutes. A session starts the authorization and the
-- provider callback saves the connection later, with no session. The signed
-- state of the authorization is valid for 10 minutes. So a session that a
-- security change revoked can still complete a connect up to 10 minutes after
-- the change. A connect at least 11 minutes after the change came from a
-- current session, and so did every connect after it. The margin can suspend
-- a connection that a current session saved in those minutes; it can never
-- keep a planted connection active.
UPDATE user_github_connections c
SET owner_security_version = li.security_version
FROM local_identities li
WHERE li.tenant_id = c.tenant_id
  AND li.user_id = c.user_id
  AND c.owner_security_version IS NULL
  AND (
    c.created_at >= li.updated_at + INTERVAL '11 minutes'
    OR EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.tenant_id = c.tenant_id
        AND a.event_type = 'user.github.connected'
        AND a.user_id = c.user_id
        AND a.created_at >= li.updated_at + INTERVAL '11 minutes'
    )
  );

UPDATE user_notion_connections c
SET owner_security_version = li.security_version
FROM local_identities li
WHERE li.tenant_id = c.tenant_id
  AND li.user_id = c.user_id
  AND c.owner_security_version IS NULL
  AND (
    c.created_at >= li.updated_at + INTERVAL '11 minutes'
    OR EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.tenant_id = c.tenant_id
        AND a.event_type = 'user.notion.connected'
        AND a.user_id = c.user_id
        AND a.created_at >= li.updated_at + INTERVAL '11 minutes'
    )
  );

UPDATE user_microsoft_connections c
SET owner_security_version = li.security_version
FROM local_identities li
WHERE li.tenant_id = c.tenant_id
  AND li.user_id = c.user_id
  AND c.owner_security_version IS NULL
  AND (
    c.created_at >= li.updated_at + INTERVAL '11 minutes'
    OR EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.tenant_id = c.tenant_id
        AND a.event_type = 'user.microsoft.connected'
        AND a.user_id = c.user_id
        AND a.created_at >= li.updated_at + INTERVAL '11 minutes'
    )
  );

-- Jira: the save is the site selection, a request of a session. There is no
-- callback, so the margin is one minute, as in migration 080: now() is the
-- start time of a transaction, so a save that raced a security change by
-- milliseconds could otherwise look newer than the change.
UPDATE user_jira_connections c
SET owner_security_version = li.security_version
FROM local_identities li
WHERE li.tenant_id = c.tenant_id
  AND li.user_id = c.user_id
  AND c.owner_security_version IS NULL
  AND (
    c.created_at >= li.updated_at + INTERVAL '1 minute'
    OR EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.tenant_id = c.tenant_id
        AND a.event_type = 'user.jira.connected'
        AND a.user_id = c.user_id
        AND a.created_at >= li.updated_at + INTERVAL '1 minute'
    )
  );

-- MCP credentials: only a save writes a secret. Removal, a binding rotation
-- and the stale-secret cleanup set it to NULL. So on a row with a secret,
-- updated_at is the time of the last save, a request of a session. Rows
-- without a secret are not usable, so they stay NULL.
UPDATE member_mcp_credentials c
SET owner_security_version = li.security_version
FROM local_identities li
WHERE li.tenant_id = c.tenant_id
  AND li.user_id = c.user_id
  AND c.owner_security_version IS NULL
  AND c.secret_encrypted IS NOT NULL
  AND c.updated_at >= li.updated_at + INTERVAL '1 minute';
