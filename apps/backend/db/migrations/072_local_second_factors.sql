-- Second factors for local accounts: an authenticator app (TOTP) and one-time
-- recovery codes. See docs/ARCHITECTURE.md, "Authentication".

-- Which members of a local tenant must have a second factor.
ALTER TABLE tenants
  ADD COLUMN mfa_policy text NOT NULL DEFAULT 'optional'
    CONSTRAINT tenants_mfa_policy_check
    CHECK (mfa_policy IN ('optional', 'required_for_admins', 'required_for_all'));

-- Set by a manager's second-factor reset: the account must enrol a new factor
-- at its next sign-in, whatever the tenant policy.
ALTER TABLE local_identities
  ADD COLUMN mfa_enrollment_required boolean NOT NULL DEFAULT false;

-- One authenticator app per account. The secret is encrypted with
-- DATA_ENCRYPTION_SECRET. A new enrolment writes the pending columns; a
-- confirmed code moves them to the active columns. last_used_step stops a
-- code from being used twice.
CREATE TABLE user_totp_factors (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  secret_encrypted text,
  confirmed_at timestamptz,
  last_used_step bigint,
  pending_secret_encrypted text,
  pending_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT user_totp_factors_identity_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES local_identities (tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT user_totp_factors_confirmed_check
    CHECK ((secret_encrypted IS NULL) = (confirmed_at IS NULL))
);

ALTER TABLE user_totp_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_totp_factors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_totp_factors
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Ten codes per account, shown once. Stored as HMAC-SHA256 under a key
-- derived from DATA_ENCRYPTION_SECRET; key_label names the derivation, so a
-- later key change can tell old rows apart.
CREATE TABLE user_recovery_codes (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  code_hash text NOT NULL,
  key_label text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, code_hash),
  CONSTRAINT user_recovery_codes_identity_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES local_identities (tenant_id, user_id) ON DELETE CASCADE
);

ALTER TABLE user_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_recovery_codes
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
