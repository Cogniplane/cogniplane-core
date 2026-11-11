import type { Pool, PoolClient } from "pg";
import { afterEach, expect, test, vi } from "vitest";

// The command runs when its module loads, so this file imports it once, with
// the database calls replaced. Only the pool that the command builds is real:
// building a pool opens no connection.
const mocks = vi.hoisted(() => ({
  migrationUrl: "postgres://postgres:migrate-secret@db.test:5432/cogniplane",
  maintenanceUrl: "postgres://maintenance_user:maint-secret@db.test:5432/cogniplane",
  applyMigrations: vi.fn<(
    db: Pool,
    migrationsDir: string,
    log: (message: string) => void,
    afterMigrations?: (client: PoolClient) => Promise<void>
  ) => Promise<string[]>>(),
  setupDeepAgentsCheckpointer: vi.fn<(migrationDatabaseUrl: string) => Promise<void>>(async () => undefined)
}));

// loadConfig reads apps/backend/.env into process.env. The test sets the
// environment of the command itself.
vi.mock("../config.js", () => ({
  loadConfig: () => ({ MAINTENANCE_DATABASE_URL: mocks.maintenanceUrl })
}));
vi.mock("./migrate-lib.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./migrate-lib.js")>(),
  applyMigrations: mocks.applyMigrations
}));
vi.mock("../services/deep-agents/deep-agents-checkpointer.js", () => ({
  DEEP_AGENTS_CHECKPOINT_SCHEMA: "deep_agents",
  setupDeepAgentsCheckpointer: mocks.setupDeepAgentsCheckpointer
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("db:migrate runs the migrations on the migration pool, which has no statement timeout", async () => {
  vi.stubEnv("MIGRATION_DATABASE_URL", mocks.migrationUrl);
  vi.stubEnv("APP_USER_PASSWORD", "app-secret");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const pinnedQueries: string[] = [];
  const pinned = {
    query: async (sql: string) => {
      pinnedQueries.push(sql);
      return { rows: [], rowCount: 0 };
    }
  } as unknown as PoolClient;
  mocks.applyMigrations.mockImplementation(async (_db, _dir, _log, afterMigrations) => {
    await afterMigrations?.(pinned);
    return [];
  });

  await import("./migrate.js");

  expect(mocks.applyMigrations).toHaveBeenCalledTimes(1);
  const [db, migrationsDir] = mocks.applyMigrations.mock.calls[0]!;
  expect(migrationsDir).toMatch(/[\\/]db[\\/]migrations$/);
  // Not a serving pool: a 30-second cap there stops long validations and
  // backfills. applyMigrations sets the statement and lock timeouts of the
  // migration session itself.
  expect(db.options).toMatchObject({
    connectionString: mocks.migrationUrl,
    application_name: "cogniplane-migrate",
    max: 1
  });
  expect(db.options.statement_timeout).toBeUndefined();
  // Checkpoint DDL opens its own connection with the migration URL, under the
  // migration lock. Role setup runs on the pinned client.
  expect(mocks.setupDeepAgentsCheckpointer).toHaveBeenCalledWith(mocks.migrationUrl);
  expect(pinnedQueries.some((sql) => sql.includes("ALTER ROLE maintenance_user"))).toBe(true);
  expect(pinnedQueries.some((sql) => sql.includes("CREATE ROLE app_user"))).toBe(true);
  // The command closes its pool.
  expect(db.ending).toBe(true);
});
