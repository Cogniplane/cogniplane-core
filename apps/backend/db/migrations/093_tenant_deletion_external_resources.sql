-- Counts of the deleted tenant's resources outside this database: saved E2B
-- sandbox ids, Pipedream Jira identities and pending Jira cleanups, OAuth
-- connections and personal MCP credentials. Tenant deletion reads them in its
-- transaction before the cascade deletes the rows, so the operator can base
-- the third-party disposition on data. The value holds counts only: no id,
-- account label, token or secret.
--
-- NULL: the receipt was written before this column existed, and the counts
-- were not recorded. A replay of such a request does not fill it, because the
-- rows are gone.
ALTER TABLE tenant_deletion_receipts
  ADD COLUMN external_resources jsonb
    CHECK (external_resources IS NULL OR jsonb_typeof(external_resources) = 'object');
