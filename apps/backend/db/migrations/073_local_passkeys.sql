-- Passkeys (WebAuthn credentials) of local accounts: passwordless sign-in, a
-- second factor, and step-up. See docs/ARCHITECTURE.md, "Authentication".

-- credential_id is unique across every tenant: passwordless sign-in finds
-- the account by it before the tenant is known (maintenance pool, read
-- only). public_key is the COSE key; it is not secret. counter is the
-- authenticator's signature counter; synced passkeys keep it at 0.
CREATE TABLE user_passkeys (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  credential_id text NOT NULL,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  name text NOT NULL,
  aaguid text,
  device_type text NOT NULL,
  backed_up boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (tenant_id, credential_id),
  CONSTRAINT user_passkeys_credential_id_key UNIQUE (credential_id),
  CONSTRAINT user_passkeys_identity_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES local_identities (tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT user_passkeys_device_type_check CHECK (device_type IN ('singleDevice', 'multiDevice')),
  CONSTRAINT user_passkeys_counter_check CHECK (counter >= 0),
  CONSTRAINT user_passkeys_name_check CHECK (char_length(name) BETWEEN 1 AND 64)
);

CREATE INDEX user_passkeys_user_idx ON user_passkeys (tenant_id, user_id);

ALTER TABLE user_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_passkeys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_passkeys
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
