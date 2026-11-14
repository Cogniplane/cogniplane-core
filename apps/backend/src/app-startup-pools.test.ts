// buildApp opens three pools: the app pool, the maintenance pool and the turn
// control pool. Both app_user pools pass the application role check, a failed
// check closes all three, and the lifecycle gets the turn control pool to
// close it at shutdown.

import { afterEach, expect, test, vi } from "vitest";

import { FakePool } from "./test-helpers/fake-pool.js";
import { createTestConfig } from "./test-helpers/test-config.js";

vi.mock("./config.js", async (original) => ({ ...await original<typeof import("./config.js")>(), loadConfig: vi.fn() }));
vi.mock("./lib/db.js", async (original) => ({
  ...await original<typeof import("./lib/db.js")>(),
  createDatabase: vi.fn(), createMaintenanceDatabase: vi.fn(), createTurnControlDatabase: vi.fn()
}));
vi.mock("./lib/maintenance-db.js", () => ({ assertApplicationRole: vi.fn(), assertMaintenanceRole: vi.fn() }));
vi.mock("./lib/redis.js", () => ({ getRedis: vi.fn(() => null), closeRedis: vi.fn(), REDIS_COMMAND_TIMEOUT_MS: 2_000 }));
vi.mock("./app-bootstrap.js", async (original) => ({
  ...await original<typeof import("./app-bootstrap.js")>(), registerAppLifecycle: vi.fn()
}));

import { buildApp } from "./app.js";
import { registerAppLifecycle } from "./app-bootstrap.js";
import { loadConfig } from "./config.js";
import { createDatabase, createMaintenanceDatabase, createTurnControlDatabase, type Pool } from "./lib/db.js";
import { assertApplicationRole } from "./lib/maintenance-db.js";

function pools() {
  const ended: string[] = [];
  const make = (name: string) => {
    const pool = new FakePool().asPool();
    (pool as unknown as { end: () => Promise<void> }).end = async () => { ended.push(name); };
    return pool;
  };
  const app = make("app");
  const maintenance = make("maintenance");
  const control = make("turn control");
  vi.mocked(createDatabase).mockReturnValue(app);
  vi.mocked(createMaintenanceDatabase).mockReturnValue(maintenance);
  vi.mocked(createTurnControlDatabase).mockReturnValue(control);
  return { app, maintenance, control, ended };
}

afterEach(() => {
  vi.clearAllMocks();
});

test("both app_user pools pass the role check, and the lifecycle gets the turn control pool", async () => {
  vi.mocked(loadConfig).mockReturnValue(createTestConfig({ MAINTENANCE_DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent" }));
  const { app: appPool, control } = pools();
  const app = await buildApp();
  try {
    expect(vi.mocked(assertApplicationRole).mock.calls.map(([pool]) => pool)).toEqual([appPool, control]);
    const lifecycle = vi.mocked(registerAppLifecycle).mock.calls[0]![0];
    expect(lifecycle.turnControlDb).toBe(control);
  } finally {
    await app.close();
  }
});

test("a failed role check closes all three pools", async () => {
  vi.mocked(loadConfig).mockReturnValue(createTestConfig({ MAINTENANCE_DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent" }));
  const { control, ended } = pools();
  vi.mocked(assertApplicationRole).mockImplementation(async (pool) => {
    if (pool === (control as unknown as Pool)) throw new Error("not an application role");
  });
  await expect(buildApp()).rejects.toThrow("not an application role");
  expect(ended.sort()).toEqual(["app", "maintenance", "turn control"]);
});
