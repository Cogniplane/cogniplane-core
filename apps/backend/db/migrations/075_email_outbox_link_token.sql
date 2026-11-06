-- A link email names the link it carries (the token hash, never the raw
-- token). The mail worker sends it only while that link still works: not
-- used, not cancelled, not expired, and issued at the account's current
-- security version. A newer link, a manager reset, or a used link therefore
-- stops an older email that is still waiting for a retry. See
-- docs/ARCHITECTURE.md, "Authentication".
ALTER TABLE email_outbox ADD COLUMN token_hash text;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_link_token_check
  CHECK ((kind IN ('password_reset_link', 'account_setup_link')) = (token_hash IS NOT NULL));
