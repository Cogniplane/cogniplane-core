# Database roles

The backend uses two runtime connections. Neither may own database objects,
create schemas, hold role memberships, or have superuser, CREATEDB, CREATEROLE,
or REPLICATION privileges. Startup checks the database role, not just the URL.
These checks apply in development and WorkOS mode.

| Connection | Role | Authority |
|---|---|---|
| `DATABASE_URL` | `app_user` | Application DML under tenant RLS, plus checkpoint DML |
| `MAINTENANCE_DATABASE_URL` | `maintenance_user` | BYPASSRLS with explicit runtime DML grants |
| `MIGRATION_DATABASE_URL` | Migration owner | Schema changes, role provisioning, explicit operator commands |

Every backend instance needs a maintenance URL. Recovery sweeps and download
tokens use it even when scheduler and retention flags are off. It has no fallback
to the application or migration connection.

## Upgrade an existing installation

1. Prepare a separate password and `MAINTENANCE_DATABASE_URL` for
   `maintenance_user`. Use the same database as the application and migration
   connections. URL-encode special characters in URL passwords.
2. Give the migration job all three URLs. Run `pnpm db:migrate` with the migration
   owner before starting the updated backend. This is an access-control change
   and must follow the installation's approval process.
3. Give the backend only the application and maintenance URLs. Remove the
   migration URL and bootstrap passwords from its environment. For local
   development, update `apps/backend/.env` from the example before `make dev`.
4. Start the backend and check readiness, login, a scheduled-job claim, and the
   retention worker logs. If startup rejects a role, inspect its grants and
   ownership. Do not replace it with the migration owner.

Migration 047 removes PUBLIC's CREATE privilege on the public schema. This matters
for older PostgreSQL installations that still grant it. Runtime roles keep USAGE.
The migration runner provisions `maintenance_user` after the numbered migrations
and checkpoint setup. It refuses to repurpose an existing owner, administrator,
or group member. It reapplies the explicit grants on each run, without default
grants on future tables. The grant implementation is
[`maintenance-role.ts`](../apps/backend/src/scripts/maintenance-role.ts).

Compose runs the migration command in a one-shot `migrate` service. The backend
waits for successful completion. Its entrypoint starts only the server and removes
bootstrap credentials. Set `MAINTENANCE_USER_PASSWORD` when using root Compose.
Other deployment systems must run the migration job separately. Starting the
backend image alone no longer applies migrations.

## Cross-tenant query inventory

| Consumer | Required tables and operations |
|---|---|
| WorkOS provisioning and membership checks | SELECT, INSERT, UPDATE on tenants, users, tenant_memberships |
| Provider credentials and PII policy | SELECT on tenant_org_settings |
| Scheduler claims and stale-run recovery | SELECT, UPDATE on scheduled_jobs and scheduled_job_runs; membership reads |
| PII claims and recovery | SELECT, UPDATE on pii_scan_jobs; SELECT on pii_scan_runs |
| Approval, execution, and message recovery | SELECT, UPDATE on approvals, session_executions, messages, message_tool_results |
| Download-token lookup and consumption | SELECT, UPDATE on artifact_download_tokens; SELECT on artifacts, sessions, projects, project_memberships, tenant_memberships |
| Session retention | SELECT, UPDATE, DELETE on sessions; SELECT, DELETE on messages, runtime_sessions, session_executions; SELECT on artifacts and project_file_versions; DML on session_storage_gc and session_runtime_gc |
| Project-file retention | SELECT, UPDATE, DELETE on project_files; SELECT, DELETE on project_file_versions; SELECT on artifacts; DML on project_file_storage_gc; INSERT on audit_events and USAGE on its sequence |

UPDATE on sessions is needed for retention's row locks. Grants combine operations
where several consumers use the same table. Tenant workers return to `app_user`
after claiming work. Foreign-key cascades delete dependent rows during retention;
the maintenance role does not get direct DELETE privileges on every child table.

The maintenance role has no access to `schema_migrations` or `deep_agents`.
Checkpoint calls still use the application role and existing session authorization.
Tenant offboarding remains an explicit operator command with separate credentials.

## Verification and limits

Run the real PostgreSQL suite with `pnpm test:integration` and
`INTEGRATION_DATABASE_URL` set to an isolated development server. The suite creates
a disposable database and two disposable runtime roles. It uses production role
provisioning for both roles. Fixtures use the owner; maintenance assertions use
the restricted login.

Tests cover identity provisioning and membership lookup, claims, stale recovery,
download checks, provider-key reads, and retention. Permission tests attempt DDL,
role creation, role switching, and access to excluded tables. They also check
startup rejection of owners, group members, and PUBLIC schema creation grants.

BYPASSRLS still permits cross-tenant access within the explicit table grants.
Queries must retain their tenant and authorization predicates. This change limits
database authority; it does not isolate each maintenance task from the others.
The PostgreSQL privilege model is described in the
[PostgreSQL documentation](https://www.postgresql.org/docs/17/ddl-priv.html).
