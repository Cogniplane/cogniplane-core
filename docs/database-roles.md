# Database roles

Scope: the three PostgreSQL roles, their authority, the runtime grants, and
the startup checks. Deployment steps are in
[self-hosting](self-hosting.md#database).

| Variable | Role | Authority | Used by |
|---|---|---|---|
| `DATABASE_URL` | `app_user` | Explicit runtime DML grants under tenant RLS, plus user/event operations and [checkpoint tables](architecture/runtime.md#checkpointer). No migration metadata or tenant deletion. | Backend (`db`) |
| `MAINTENANCE_DATABASE_URL` | `maintenance_user` | BYPASSRLS with explicit DML grants | Backend (`privilegedDb`) |
| `MIGRATION_DATABASE_URL` | Superuser | Schema changes, role provisioning | Migration job and operator commands only |

## Rules

- Set both runtime URLs on every backend instance, in every auth mode ([startup
  rules](configuration.md#startup-rules)). Neither uses the other's URL.
- Startup checks the actual roles: neither runtime role may own objects, create
  schemas, be a member of another role, or have superuser, CREATEDB, CREATEROLE
  or REPLICATION. Never use the migration role as a runtime role.
- The migration runner (`apps/backend/src/scripts/migrate.ts`) creates or
  updates both runtime roles and their passwords, applies the
  numbered migrations and checkpoint setup, then replaces both runtime grant
  lists on each run. It refuses to reuse an existing owner, administrator or
  group member as `maintenance_user`.
- The `app_user` password comes from `APP_USER_PASSWORD`, else from the
  `DATABASE_URL` that the migration job receives. The config default of
  `DATABASE_URL` is never used. The runner stops before any migration when
  neither is set, and, when `NODE_ENV` is a production value, when the password
  is the published default (`resolveAppUserPassword` in `migrate-lib.ts`). The
  `maintenance_user` password comes from `MAINTENANCE_DATABASE_URL`.
- Migration `047` removes PUBLIC's CREATE right on schema `public`.
- `maintenance_user` has no access to `schema_migrations` or `deep_agents`.
- BYPASSRLS allows cross-tenant access within these grants ([tenant data
  invariant](security.md#tenant-data)).

## Application grants

`APP_USER_GRANTS`, `APP_USER_LOCK_GRANTS`, `APP_USER_SEQUENCES` and
`APP_USER_CHECKPOINT_GRANTS` in `apps/backend/src/scripts/app-user-grants.ts`
list the application privileges. Add only the operations that runtime SQL needs.
New tables and sequences receive no automatic grant.

- Global `users` and `platform_events` allow SELECT and INSERT, not UPDATE or
  DELETE. WorkOS profile updates use `maintenance_user`. Operator deletion uses
  the migration role.
- `schema_migrations`, deep_agents.checkpoint_migrations,
  `tenant_deletion_receipts` and `tenant_deletion_cleanup` have no application
  grant. The checkpointer has access only to its three runtime tables.
- The application can enqueue storage cleanup work. Only the maintenance role
  reads and drains the queues. Retention DELETE operations stay on that role.
- Sequence USAGE permits generated ids without permission to reset a sequence.
  A column UPDATE grant on `personal_skill_revisions.tenant_id` permits its
  `FOR SHARE` row lock. RLS refuses a change to another tenant, and no other
  column has UPDATE permission.

On upgrade, run `pnpm db:migrate` from the new release before starting its
backend, even when no numbered SQL migration is pending. `ensureAppUserRole`
removes old table, column, sequence and schema grants before applying this list.
The reset and new grants commit in one transaction. A failed grant rolls back
the reset and fails the migration job. Do not run an older migration job after
this upgrade, because it would restore the old blanket grants.

## Tenant deletion boundary

Only the [tenant deletion command](operations.md#delete-a-tenant) deletes a
tenant. Every tenant table cascades from `tenants`, and a foreign-key cascade
ignores RLS. Thus a DELETE of the `tenants` row removes all rows of the tenant,
also the append-only `audit_events` rows. Two controls keep `app_user` out:

- Privilege: the migration runner removes old grants and grants only SELECT
  and UPDATE on `tenants`, on each run. TRUNCATE ignores RLS and has no grant.
- RLS: the restrictive policy `tenants_no_delete` (migration `088`) refuses
  DELETE to every role under RLS, also to a role that a bulk grant gave DELETE.

`app_user` keeps SELECT and UPDATE on `tenants` for rename and MFA policy.
It has no INSERT grant. WorkOS sign-in creates tenants on `privilegedDb`;
local tenant bootstrap uses the migration role.
`maintenance_user` has no DELETE on `tenants` (`MAINTENANCE_GRANTS`).

## Maintenance grants

`MAINTENANCE_GRANTS` in `apps/backend/src/scripts/maintenance-role.ts` is the
maintenance grant list. The code that uses them reads through `privilegedDb` (`git
grep privilegedDb apps/backend/src`).

- Tenant workers use `app_user` when they have a tenant scope. Scheduled-job
  claims already know the tenant and use `app_user` to commit the claim and
  its pending run together.
- Retention relies on foreign-key cascades; the role has no direct DELETE on
  every child table.
- A new cross-tenant worker adds its grants to `MAINTENANCE_GRANTS` and covers
  them in `pnpm test:integration`.

## Tests

`pnpm test:integration` provisions both roles with the production code in a
disposable database. It covers claims, recovery, download checks, provider-key
reads and retention, and checks that DDL, role creation, role switching,
excluded tables and unsafe role setups are refused.
`apps/backend/src/integration/app-user-grants.integration.test.ts` checks
allowed runtime operations, denied global and metadata access, and replacement
of legacy table and column grants. RLS write-path tests use temporary,
transaction-local grants for policy probes, so a denied privilege cannot hide
a broken tenant policy. Their production writers still use the real grants.
`apps/backend/src/integration/tenant-root-delete.integration.test.ts` checks the
[tenant deletion boundary](#tenant-deletion-boundary): after re-provisioning,
after an upgrade, and with a bulk grant of DELETE.
