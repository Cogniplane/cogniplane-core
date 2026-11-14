-- A member removal is a decision of the tenant, and it must last. Before this
-- table, DELETE /tenant/members/:userId only deleted the membership row, and
-- the next WorkOS sign-in of the same person created the membership again,
-- with the role from WorkOS. One row here records that the tenant removed the
-- user. The removal route writes it in the same transaction as the membership
-- delete (services/tenant-member-removal.ts), and:
--
-- - WorkOS sign-in refuses a user with a row (provisionTenantIdentity), under
--   the tenant's membership lock, so a sign-in and a removal cannot overlap;
-- - request and refresh admission refuse a session that started at or before
--   removed_at (lib/auth-admission.ts). Each refresh family of the user that
--   existed at the removal stops, also if a later change adds the membership
--   again.
--
-- No code path deletes a row. Re-admission is not a feature yet; see
-- docs/architecture/auth.md#roles.
CREATE TABLE tenant_member_removals (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(user_id),
  removed_at timestamptz NOT NULL DEFAULT NOW(),
  removed_by text REFERENCES users(user_id),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE tenant_member_removals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_member_removals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_member_removals
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Removals from before this migration. The removal route of recent builds
-- writes the audit event tenant.member.removed with the payload
-- {"targetUserId": ...}. A user with such an event and no membership now gets
-- a row, so the next WorkOS sign-in does not add the user again:
--
-- - removed_at is the time of the latest event for the user in the tenant,
--   so each refresh family from before that removal stays refused;
-- - removed_by is the actor of that event, or NULL when that user no longer
--   exists;
-- - an event whose payload has no string targetUserId, or whose target user
--   no longer exists, is skipped;
-- - a user with a membership now gets no row. The user came back after the
--   removal, and a row would refuse each next sign-in. The data does not show
--   whether the tenant wanted that return, so the membership stays.
--
-- Limits: a removal with no event (from a build that did not write it, or an
-- event that audit retention deleted) gets no row. During a rolling upgrade,
-- backends of the earlier release remove without a row, and their WorkOS
-- sign-in does not check the rows. The deferred file
-- apps/backend/db/deferred/record-member-removals.sql repeats this INSERT
-- after the rollout and lists the members who came back after a removal. See
-- docs/operations.md#upgrade-to-removal-records.
--
-- This INSERT takes no tenant membership lock, unlike the deferred file. The
-- table and its rows become visible in one commit, so a WorkOS sign-in of the
-- new release cannot check for a row before this backfill commits: it finds
-- no table and fails. A sign-in of the earlier release takes no membership
-- lock, so the lock would not stop it. The lock would also deadlock with a
-- sign-in: CREATE TABLE with foreign keys holds a SHARE ROW EXCLUSIVE lock on
-- tenants and users until commit, and a sign-in writes those tables before and
-- after it takes the membership lock.
--
-- The lateral read per tenant uses the (tenant_id, event_type, created_at)
-- index of audit_events (migration 031).
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
