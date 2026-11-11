# Database roles

Scope: the three PostgreSQL roles, their authority, the maintenance grants, and
the startup checks. Deployment steps are in
[self-hosting](self-hosting.md#database).

| Variable | Role | Authority | Used by |
|---|---|---|---|
| `DATABASE_URL` | `app_user` | DML on application tables under tenant RLS, and on [checkpoint tables](architecture/runtime.md#checkpointer) | Backend (`db`) |
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
  numbered migrations and checkpoint setup, then applies the maintenance grants
  again on each run. It refuses to reuse an existing owner, administrator or
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

## Maintenance grants

`MAINTENANCE_GRANTS` in `apps/backend/src/scripts/maintenance-role.ts` is the
only list of grants. The code that uses them reads through `privilegedDb` (`git
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
