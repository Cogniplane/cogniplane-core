// Connection plumbing for the Postgres-backed integration suite.
//
// Why this suite exists: Row-Level Security is the tenant-isolation boundary
// for every request path, and until this suite no test executed a single
// policy. Store tests assert SQL strings against `test-helpers/fake-pool.ts`,
// which understands BEGIN/COMMIT/set_config well enough that `withTenantScope`
// works unmodified — so a policy with the wrong GUC name, a table with no
// ENABLE ROW LEVEL SECURITY, or a store method that skips `withTenantScope`
// all pass the unit suite silently.
//
// Two pools, mirroring production:
//   - superuserPool() bypasses RLS. Stands in for `privilegedDb` and seeds
//     fixtures directly (bypassing store insert paths on purpose, so a policy
//     failure is never masked by a store bug).
//   - appPool() connects as `app_user`, which is subject to RLS. Every
//     assertion about isolation runs here.
//
// Each run gets a THROWAWAY database AND a throwaway role. Both matter more
// locally than in CI:
//
//  - Database: pointed at the persistent compose database, the cross-tenant
//    sweep tests would mutate real dev rows, and `applyMigrations` tracks by
//    filename so it would not re-apply an edited migration whose name is
//    already recorded.
//  - Role: Postgres roles are CLUSTER-wide, not per-database. Reusing
//    `app_user` would reset the password of the role a locally running backend
//    is connected as, breaking it, despite the separate database.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { setupDeepAgentsCheckpointer } from "../../services/deep-agents/deep-agents-checkpointer.js";
import { applyMigrations, ensureAppUserRole } from "../../scripts/migrate-lib.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(dirname, "../../../db/migrations");

/** Password the harness assigns to its throwaway role. */
export const APP_USER_PASSWORD =
  process.env.INTEGRATION_APP_USER_PASSWORD ?? "integration-app-user-password";

/**
 * Superuser DSN the suite is given. Absent means "no database available", which
 * every entry point must treat as skip rather than failure so `pnpm test:all`
 * stays green on a machine with no Postgres.
 */
export function adminDatabaseUrl(): string | undefined {
  return process.env.INTEGRATION_DATABASE_URL || undefined;
}

/**
 * Name of the per-run database. Set by globalSetup and read back here in the
 * test worker: globalSetup runs in a SEPARATE context, so nothing it puts in a
 * module-level variable is visible to the workers. An env var is the supported
 * channel between the two.
 */
const RUN_DATABASE_ENV = "INTEGRATION_RUN_DATABASE";
const RUN_ROLE_ENV = "INTEGRATION_RUN_ROLE";

export function runDatabaseName(): string {
  const name = process.env[RUN_DATABASE_ENV];
  if (!name) {
    throw new Error(
      `${RUN_DATABASE_ENV} is not set. The integration globalSetup did not run, ` +
        "or it skipped because INTEGRATION_DATABASE_URL was absent."
    );
  }
  return name;
}

export function runRoleName(): string {
  const name = process.env[RUN_ROLE_ENV];
  if (!name) {
    throw new Error(
      `${RUN_ROLE_ENV} is not set. The integration globalSetup did not run, ` +
        "or it skipped because INTEGRATION_DATABASE_URL was absent."
    );
  }
  return name;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withUser(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

/** Superuser DSN for this run's throwaway database. BYPASSRLS. */
export function runSuperuserUrl(): string {
  const admin = adminDatabaseUrl();
  if (!admin) throw new Error("INTEGRATION_DATABASE_URL is not set.");
  return withDatabase(admin, runDatabaseName());
}

/**
 * Unprivileged DSN for this run. Subject to RLS, exactly like production's
 * `app_user` — same role setup code, same grants, just a per-run role name.
 */
export function runAppUserUrl(): string {
  return withUser(runSuperuserUrl(), runRoleName(), APP_USER_PASSWORD);
}

// Pools are created lazily in the WORKER and closed by the worker's own
// afterAll (see setup.ts). globalSetup cannot own them: its pools are in a
// different context, so a global teardown would close pools the tests never
// used while leaving the real ones open, and Vitest would hang on exit.
let superuser: pg.Pool | undefined;
let appUser: pg.Pool | undefined;

export function superuserPool(): pg.Pool {
  superuser ??= new pg.Pool({
    connectionString: runSuperuserUrl(),
    max: 5,
    application_name: "cogniplane-integration-superuser"
  });
  return superuser;
}

export function appPool(): pg.Pool {
  appUser ??= new pg.Pool({
    connectionString: runAppUserUrl(),
    max: 5,
    application_name: "cogniplane-integration-app-user"
  });
  return appUser;
}

export async function closePools(): Promise<void> {
  await Promise.all([superuser?.end(), appUser?.end()]);
  superuser = undefined;
  appUser = undefined;
}

/**
 * Create the throwaway database, migrate it, and set up `app_user`.
 *
 * Returns the database name, or undefined when no database is configured.
 * Called from globalSetup only.
 */
/**
 * Both names are interpolated (CREATE/DROP DATABASE and DROP ROLE take no bind
 * parameters), so every value that reaches those statements is checked against
 * the exact shape this harness generates. `createRunDatabase` only ever builds
 * safe names, but `dropRunDatabase` is exported and takes strings, so the guard
 * lives at the point of use rather than resting on the caller.
 */
function assertHarnessIdentifier(name: string): void {
  if (!/^cogniplane_it_(role_)?[0-9a-f]{32}$/.test(name)) {
    throw new Error(
      `Refusing to interpolate "${name}": not a harness-generated identifier. ` +
        "Expected cogniplane_it_<32 hex> or cogniplane_it_role_<32 hex>."
    );
  }
}

export async function createRunDatabase(): Promise<
  { database: string; role: string } | undefined
> {
  const admin = adminDatabaseUrl();
  if (!admin) return undefined;

  const suffix = randomUUID().replace(/-/g, "");
  const database = `cogniplane_it_${suffix}`;
  // Lowercase identifier, which is what ensureAppUserRole accepts.
  const role = `cogniplane_it_role_${suffix}`;
  assertHarnessIdentifier(database);
  assertHarnessIdentifier(role);

  const adminPool = new pg.Pool({ connectionString: admin, max: 1 });
  try {
    // Not parameterizable: CREATE DATABASE takes no bind parameters. The name
    // is a locally generated UUID with the dashes stripped, so there is no
    // caller-supplied text in it.
    await adminPool.query(`CREATE DATABASE ${database}`);
  } finally {
    await adminPool.end();
  }

  const runUrl = withDatabase(admin, database);
  const runPool = new pg.Pool({ connectionString: runUrl, max: 1 });
  try {
    // Silence the per-migration log; a failure still throws with the file name.
    await applyMigrations(runPool, MIGRATIONS_DIR, () => {});
    await setupDeepAgentsCheckpointer(runUrl);

    const client = await runPool.connect();
    try {
      // The same role setup production runs, via the same function. Shared on
      // purpose: see ensureAppUserRole's header for what a private copy of the
      // grants here would let through. Only the role NAME differs, because
      // roles are cluster-wide.
      await ensureAppUserRole(client, APP_USER_PASSWORD, role);
    } finally {
      client.release();
    }
  } catch (error) {
    // The database (and possibly the role) already exist at this point, but
    // globalSetup never receives them, so it can never register a teardown.
    // Clean up here or a failed migration orphans a database on every run.
    await runPool.end().catch(() => {});
    await dropRunDatabase(database, role).catch(() => {});
    throw error;
  } finally {
    // Idempotent: a second end() on an already-ended pool resolves.
    await runPool.end().catch(() => {});
  }

  return { database, role };
}

/**
 * Drop the throwaway database and role. Called from globalSetup's teardown.
 *
 * The role must go too, and only after the database: a role still owning
 * objects cannot be dropped, and a leaked role accumulates on a shared server
 * run after run. `WITH (FORCE)` terminates any connection the suite left open
 * so the drop cannot hang on a straggler.
 */
export async function dropRunDatabase(database: string, role: string): Promise<void> {
  const admin = adminDatabaseUrl();
  if (!admin) return;

  assertHarnessIdentifier(database);
  assertHarnessIdentifier(role);

  const adminPool = new pg.Pool({ connectionString: admin, max: 1 });
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    // The role owns nothing outside the dropped database, but its grants are
    // recorded per-database and went with it, so this is unconditional.
    await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
  } finally {
    await adminPool.end();
  }
}

/**
 * Drop harness databases and roles left behind by a crashed run.
 *
 * SIGKILL, a cancelled CI job, or a killed local run all bypass globalSetup's
 * teardown. CI does not care (the whole service container disappears), but a
 * local server accumulates them. Exposed so `make test-integration` can sweep
 * before it starts.
 *
 * IN USE IS NOT ORPHANED. Two runs can share a server — two worktrees, or a
 * re-run started before the first finished — and `WITH (FORCE)` would terminate
 * the other run's connections and drop its database mid-test. A live run always
 * holds pool connections, so `pg_stat_activity` separates the two cases. Its
 * role is skipped alongside its database: dropping the role a live run
 * authenticates as breaks it just as thoroughly.
 *
 * This leaves one narrow race, where a run is momentarily holding no
 * connection. Losing a sweep to that is harmless (the database is cleaned up
 * next time); winning it would kill a running suite.
 */
export async function dropOrphanedRunDatabases(): Promise<string[]> {
  const admin = adminDatabaseUrl();
  if (!admin) return [];

  const adminPool = new pg.Pool({ connectionString: admin, max: 1 });
  const dropped: string[] = [];
  try {
    const { rows } = await adminPool.query<{ datname: string }>(
      `SELECT d.datname
         FROM pg_database d
        WHERE d.datname ~ '^cogniplane_it_[0-9a-f]{32}$'
          AND NOT EXISTS (
                SELECT 1 FROM pg_stat_activity a
                 WHERE a.datname = d.datname
                   AND a.pid <> pg_backend_pid()
              )`
    );
    for (const row of rows) {
      assertHarnessIdentifier(row.datname);
      await adminPool.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);
      dropped.push(row.datname);
    }

    // A run's role shares its database's 32-hex suffix, so only sweep roles
    // whose database is gone — either dropped just now, or by an earlier run.
    const { rows: roles } = await adminPool.query<{ rolname: string }>(
      `SELECT r.rolname
         FROM pg_roles r
        WHERE r.rolname ~ '^cogniplane_it_role_[0-9a-f]{32}$'
          AND NOT EXISTS (
                SELECT 1 FROM pg_database d
                 WHERE d.datname = replace(r.rolname, 'cogniplane_it_role_', 'cogniplane_it_')
              )`
    );
    for (const row of roles) {
      assertHarnessIdentifier(row.rolname);
      await adminPool.query(`DROP ROLE IF EXISTS ${row.rolname}`);
      dropped.push(row.rolname);
    }
  } finally {
    await adminPool.end();
  }
  return dropped;
}
