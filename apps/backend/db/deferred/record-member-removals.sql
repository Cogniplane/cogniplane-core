-- Run once, after every backend runs the release with migration 091
-- (tenant_member_removals). Run it with psql and the migration credential.
-- See docs/operations.md#upgrade. It is safe to run again.
--
-- During a rolling upgrade, a backend of the earlier release removes a member
-- without a removal row, and its WorkOS sign-in admits a removed user without
-- the check. This file closes that window:
--
-- 1. It repeats the backfill of migration 091: a user with a
--    tenant.member.removed audit event and no membership now gets a row. Rows
--    that exist stay as they are.
-- 2. It lists the members whose membership started after their latest
--    removal: a WorkOS sign-in that added the user again, during the rollout
--    or before the upgrade. The data does not show whether the tenant wanted
--    the return. An owner or admin of each listed tenant decides, and removes
--    the member again in Admin > People when the return was not wanted. That
--    removal records a row and refuses each session of the user.
--
-- Each tenant's membership lock comes first, before any read. A WorkOS sign-in
-- of the new release holds that lock from its removal check until it commits
-- the membership (services/auth/workos-tenant-provisioning.ts). Without the
-- lock, this file could read no membership, record a removal after that check,
-- and the sign-in could then add the membership with a session that starts
-- after removed_at: admission would accept the session. With the lock, a
-- sign-in that started first commits its membership, and this file keeps it
-- and lists it in step 2. A sign-in that starts later waits, finds the row and
-- is refused. A table lock would not do: a sign-in can do its check before
-- this file starts, and only wait at its membership INSERT.
--
-- The locks are the same as lockTenantMembership (services/member-authority.ts)
-- and are taken in tenant_id order. No other transaction holds two of them,
-- and none waits for one while it holds a lock that this file needs, so there
-- is no lock cycle. Sign-ins and member changes wait until this file commits.
-- READ COMMITTED gives each statement after the locks a new snapshot, so the
-- INSERT sees each membership that a sign-in committed before its lock.
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  tenant record;
BEGIN
  FOR tenant IN SELECT tenant_id FROM tenants ORDER BY tenant_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext('tenant_membership_changes'), hashtext(tenant.tenant_id));
  END LOOP;
END
$$;

INSERT INTO tenant_member_removals (tenant_id, user_id, removed_at, removed_by)
SELECT DISTINCT ON (e.tenant_id, e.target_user_id)
  e.tenant_id,
  e.target_user_id,
  e.created_at,
  (SELECT actor.user_id FROM users actor WHERE actor.user_id = e.actor_id)
FROM tenants t
CROSS JOIN LATERAL (
  SELECT a.id, a.tenant_id, a.payload->>'targetUserId' AS target_user_id, a.user_id AS actor_id, a.created_at
  FROM audit_events a
  WHERE a.tenant_id = t.tenant_id
    AND a.event_type = 'tenant.member.removed'
    AND jsonb_typeof(a.payload->'targetUserId') = 'string'
) e
JOIN users target ON target.user_id = e.target_user_id
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_memberships m
  WHERE m.tenant_id = e.tenant_id AND m.user_id = e.target_user_id
)
ORDER BY e.tenant_id, e.target_user_id, e.created_at DESC, e.id DESC
ON CONFLICT (tenant_id, user_id) DO NOTHING;

SELECT m.tenant_id, t.tenant_name, m.user_id, u.email, m.role,
  m.created_at AS member_since, latest.removed_at AS latest_removal
FROM tenant_memberships m
JOIN tenants t ON t.tenant_id = m.tenant_id
JOIN users u ON u.user_id = m.user_id
CROSS JOIN LATERAL (
  SELECT max(a.created_at) AS removed_at
  FROM audit_events a
  WHERE a.tenant_id = m.tenant_id
    AND a.event_type = 'tenant.member.removed'
    AND jsonb_typeof(a.payload->'targetUserId') = 'string'
    AND a.payload->>'targetUserId' = m.user_id
) latest
WHERE latest.removed_at < m.created_at
ORDER BY m.tenant_id, m.created_at;

COMMIT;
