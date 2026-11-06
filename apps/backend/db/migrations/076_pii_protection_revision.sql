-- A counter for the PII settings. Each successful PII save adds 1. An admin
-- save that names an older revision is refused, so a save from a stale form
-- cannot replace a newer save. The counter is separate from updated_at,
-- because a change to another org setting (a provider key, for example) also
-- changes updated_at. See TenantOrgSettingsStore.setPiiProtection.
ALTER TABLE tenant_org_settings
  ADD COLUMN pii_protection_revision integer NOT NULL DEFAULT 0;
