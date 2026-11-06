-- Local accounts, docs/ARCHITECTURE.md, "Authentication".
--
-- A local account belongs to one tenant: its home tenant. The rule is kept by
-- foreign keys, not triggers. Postgres checks foreign keys without row-level
-- security and with the right key locks, while a trigger would run under RLS
-- and could not see the rows of other tenants.
--
--   users (user_id, auth_source)  <- local_identities (user_id, auth_source)
--                                 <- tenant_memberships (user_id, user_auth_source)
--   local_identities (tenant_id, user_id)
--                                 <- tenant_memberships (local_tenant_id, user_id)
--
-- local_identities.user_id is unique, so a local user has one identity, in one
-- tenant. A membership of a local user must point to that identity, so its
-- tenant is the home tenant. A membership of a WorkOS user has
-- local_tenant_id NULL, and Postgres does not check that key (MATCH SIMPLE).
-- Both discriminator columns are NOT NULL: a NULL would make Postgres skip
-- both keys and let a local user join a second tenant.

ALTER TABLE users ADD CONSTRAINT users_user_id_auth_source_key UNIQUE (user_id, auth_source);

-- Mutable local state. Tenant routes change this table, never the global
-- users table, after an account exists.
CREATE TABLE local_identities (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  auth_source text NOT NULL DEFAULT 'local'
    CONSTRAINT local_identities_auth_source_check CHECK (auth_source = 'local'),
  status text NOT NULL
    CONSTRAINT local_identities_status_check
    CHECK (status IN ('pending_setup', 'active', 'disabled', 'removed')),
  -- Every token of a local session carries the value it had at sign-in. Any
  -- security change increments it, which ends every older session.
  security_version integer NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT local_identities_user_id_key UNIQUE (user_id),
  CONSTRAINT local_identities_user_fkey FOREIGN KEY (user_id, auth_source)
    REFERENCES users (user_id, auth_source) ON DELETE CASCADE
);

ALTER TABLE local_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_identities
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

ALTER TABLE tenant_memberships
  ADD COLUMN user_auth_source text NOT NULL DEFAULT 'workos',
  ADD COLUMN local_tenant_id text
    GENERATED ALWAYS AS (CASE WHEN user_auth_source = 'local' THEN tenant_id END) STORED;
ALTER TABLE tenant_memberships
  ADD CONSTRAINT tenant_memberships_user_auth_source_fkey FOREIGN KEY (user_id, user_auth_source)
    REFERENCES users (user_id, auth_source) ON DELETE CASCADE,
  ADD CONSTRAINT tenant_memberships_local_identity_fkey FOREIGN KEY (local_tenant_id, user_id)
    REFERENCES local_identities (tenant_id, user_id);

-- The password of a local account. A row exists only after the user set one.
CREATE TABLE local_passwords (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  -- PHC string: algorithm, parameters, salt, and hash.
  password_hash text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT local_passwords_identity_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES local_identities (tenant_id, user_id) ON DELETE CASCADE
);

ALTER TABLE local_passwords ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_passwords FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_passwords
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- One-time links: account setup and password reset. Only
-- the SHA-256 of the token is stored. A token is valid only while the
-- identity's security_version equals the version it was issued at.
CREATE TABLE auth_action_tokens (
  token_hash text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  purpose text NOT NULL
    CONSTRAINT auth_action_tokens_purpose_check CHECK (purpose IN ('account_setup', 'password_reset')),
  security_version integer NOT NULL,
  -- The manager who asked for the link; NULL for operator commands and
  -- self-service.
  created_by text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_action_tokens_identity_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES local_identities (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX auth_action_tokens_open_idx
  ON auth_action_tokens (tenant_id, user_id, purpose) WHERE used_at IS NULL;

ALTER TABLE auth_action_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_action_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_action_tokens
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
