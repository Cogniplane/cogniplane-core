-- Email to local accounts: security notices now, links later. A message is
-- written here in the same transaction as the change it reports, and a
-- worker sends it after commit. See docs/ARCHITECTURE.md, "Authentication".

-- message_encrypted holds the recipient, subject, and bodies, encrypted with
-- DATA_ENCRYPTION_SECRET. It is set only while the message waits to go
-- (queued or sending); the worker clears it when the message is sent, fails,
-- or expires. The row then keeps only delivery facts, and the worker deletes
-- it after 30 days. last_error holds an error code, never server text.
CREATE TABLE email_outbox (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  email_id text NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL,
  message_encrypted text,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token text,
  claimed_at timestamptz,
  expires_at timestamptz NOT NULL,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, email_id),
  CONSTRAINT email_outbox_identity_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES local_identities (tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_outbox_status_check CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'expired')),
  CONSTRAINT email_outbox_kind_check CHECK (kind IN (
    'password_changed', 'factor_added', 'factor_removed',
    'admin_password_reset', 'admin_factors_reset',
    'password_reset_link', 'account_setup_link'
  )),
  CONSTRAINT email_outbox_message_check CHECK ((status IN ('queued', 'sending')) = (message_encrypted IS NOT NULL)),
  CONSTRAINT email_outbox_claim_check CHECK ((status = 'sending') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CONSTRAINT email_outbox_attempts_check CHECK (attempts >= 0)
);

-- The worker's queue scan, and the per-account reads (latest delivery).
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'queued';
CREATE INDEX email_outbox_sending_idx ON email_outbox (claimed_at) WHERE status = 'sending';
CREATE INDEX email_outbox_user_idx ON email_outbox (tenant_id, user_id, created_at DESC);
CREATE INDEX email_outbox_done_idx ON email_outbox (updated_at) WHERE status IN ('sent', 'failed', 'expired');

ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_outbox
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
