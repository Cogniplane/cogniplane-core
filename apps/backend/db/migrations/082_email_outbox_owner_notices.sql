-- Owner notices for data setting changes. A change of a tenant setting that
-- changes where the tenant's data goes (a provider key, an MCP server's
-- address, an integration's settings, and similar) queues one notice to each
-- owner of the tenant, in the same transaction. WorkOS owners get it too: for
-- a WorkOS session the notice is the only check, because Cogniplane cannot
-- ask WorkOS for a step-up. See docs/ARCHITECTURE.md, "Authentication".
--
-- So a row now belongs to a member of the tenant, not only to a local
-- account. The foreign key moves from local_identities to tenant_memberships.
-- Every local account has a membership while it can get email, so the
-- existing writers keep their order (the membership exists before a link or
-- a notice is queued).
--
-- Removing a member now deletes the member's rows. Before, removal kept the
-- local identity (marked removed), so the rows stayed until the worker
-- deleted them after 30 days. A removed member's link no longer works and
-- its notices are no longer needed; the audit log keeps the events.

-- Rows of accounts that are no longer members (removed local accounts):
-- without this, the new foreign key cannot be added.
DELETE FROM email_outbox o
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_memberships tm
  WHERE tm.tenant_id = o.tenant_id AND tm.user_id = o.user_id
);

ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_identity_fkey;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_membership_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE CASCADE;

ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check CHECK (kind IN (
  'password_changed', 'factor_added', 'factor_removed',
  'admin_password_reset', 'admin_factors_reset',
  'tenant_setting_changed',
  'password_reset_link', 'account_setup_link'
));
