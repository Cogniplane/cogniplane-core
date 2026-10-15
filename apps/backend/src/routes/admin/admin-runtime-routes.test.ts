import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Pool } from "../../lib/db.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";
import { registerAdminRuntimeRoutes } from "./admin-runtime-routes.js";

const apps: Array<Awaited<ReturnType<typeof Fastify>>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const app of apps.splice(0)) await app.close();
});

type RuntimeDetail = {
  sessionId: string;
  runtimeId: string;
  healthStatus: "healthy";
  lastActiveAt: string;
  hasActiveTurn: boolean;
};

async function buildApp(opts: { isAdmin?: boolean; tenants?: Record<string, RuntimeDetail[]> } = {}) {
  const askedTenants: string[] = [];
  const app = Fastify();
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-1",
      tenantId: "tenant-a",
      isAdmin: opts.isAdmin ?? true,
      role: opts.isAdmin === false ? "member" : "admin"
    };
  });
  await registerAdminRuntimeRoutes(app, {
    auditEvents: { async create() {} } as never,
    runtimeSessions: { async listRecent() { return []; } },
    deepAgentsAdapter: {
      getRuntimeHealthDetail(tenantId: string) {
        askedTenants.push(tenantId);
        return opts.tenants?.[tenantId] ?? [];
      },
      async invalidateTenantRuntimes() { return []; }
    }
  });
  await app.ready();
  apps.push(app);
  return { app, askedTenants };
}

const runtime = (sessionId: string, hasActiveTurn: boolean): RuntimeDetail => ({
  sessionId,
  runtimeId: `runtime-${sessionId}`,
  healthStatus: "healthy",
  lastActiveAt: "2026-10-14T00:00:00.000Z",
  hasActiveTurn
});

describe("GET /admin/diagnostics", () => {
  test("returns build, uptime and runtime counts to an admin", async () => {
    vi.stubEnv("BUILD_SHA", "0123456789abcdef0123456789abcdef01234567");
    vi.stubEnv("BUILD_DATE", "2026-10-13T01:37:23Z");
    const { app } = await buildApp({
      tenants: { "tenant-a": [runtime("s1", true), runtime("s2", false), runtime("s3", true)] }
    });

    const response = await app.inject({ method: "GET", url: "/admin/diagnostics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      uptimeSeconds: expect.any(Number),
      version: { sha: "0123456789abcdef0123456789abcdef01234567", buildDate: "2026-10-13T01:37:23Z" },
      runtimes: { activeRuntimeCount: 3, activeTurnCount: 2 }
    });
  });

  test("falls back to dev and an empty build date when the build is not stamped", async () => {
    vi.stubEnv("BUILD_SHA", undefined);
    vi.stubEnv("BUILD_DATE", undefined);
    const { app } = await buildApp();

    const response = await app.inject({ method: "GET", url: "/admin/diagnostics" });

    expect(response.json().version).toEqual({ sha: "dev", buildDate: "" });
    expect(response.json().runtimes).toEqual({ activeRuntimeCount: 0, activeTurnCount: 0 });
  });

  test("counts only the caller's tenant, never other tenants' runtimes", async () => {
    const { app, askedTenants } = await buildApp({
      tenants: {
        "tenant-a": [runtime("a1", false)],
        "tenant-b": [runtime("b1", true), runtime("b2", true)]
      }
    });

    const response = await app.inject({ method: "GET", url: "/admin/diagnostics" });

    expect(response.json().runtimes).toEqual({ activeRuntimeCount: 1, activeTurnCount: 0 });
    expect(askedTenants).toEqual(["tenant-a"]);
  });

  test("rejects non-admins without any diagnostic detail", async () => {
    vi.stubEnv("BUILD_SHA", "0123456789abcdef0123456789abcdef01234567");
    const { app, askedTenants } = await buildApp({ isAdmin: false });

    const response = await app.inject({ method: "GET", url: "/admin/diagnostics" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "admin_required" });
    expect(response.body).not.toContain("0123456789abcdef");
    expect(askedTenants).toEqual([]);
  });
});
