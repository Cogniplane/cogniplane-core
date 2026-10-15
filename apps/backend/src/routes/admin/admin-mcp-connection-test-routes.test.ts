import Fastify from "fastify";
import { expect, onTestFinished, test, vi } from "vitest";
import type { AdminMcpConnectionTest } from "@cogniplane/shared-types";
import type { Pool } from "../../lib/db.js";
import type { AdminMcpServerRecord } from "../../services/admin-config-records.js";
import { McpConnectionTestConflictError, McpConnectionTestNotFoundError } from "../../services/mcp/mcp-connection-test-service.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";
import { registerAdminMcpServerRoutes } from "./admin-mcp-server-routes.js";

const server: AdminMcpServerRecord = {
  serverId: "research", ownerTenantId: "tenant-a", serverName: "Research", description: null,
  transportKind: "http", mode: "proxy", routePath: "/mcp/research", upstreamUrl: "https://example.test/mcp",
  upstreamAuthType: "bearer", upstreamAuthName: null, upstreamAuthConfigured: true,
  credentialScope: "organization", credentialBindingId: "binding", version: 3, configHash: "a".repeat(64),
  enabled: true, isPublished: true, createdBy: "admin-a", createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z"
};
const check: AdminMcpConnectionTest = {
  serverId: server.serverId, configVersion: server.version, configHash: server.configHash,
  checkedAt: server.updatedAt, credentialScope: "organization", testedUserId: null,
  reachability: "reachable", authentication: "accepted", toolDiscovery: "succeeded", toolCount: 2,
  message: "Tool discovery completed. No tool was executed."
};
const payload = { expectedVersion: server.version, expectedConfigHash: server.configHash };
const url = `/admin/mcp-servers/${server.serverId}/connection-test`;

async function setup(isAdmin = true) {
  const app = Fastify();
  onTestFinished(() => app.close());
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async request => {
    request.auth = { tenantId: "tenant-a", userId: "admin-a", isAdmin, role: isAdmin ? "owner" : "member" };
  });
  const run = vi.fn(async () => check);
  const listLatest = vi.fn(async () => new Map([[server.serverId, check]]));
  const dynamicConfig: Parameters<typeof registerAdminMcpServerRoutes>[1]["dynamicConfig"] = {
    listMcpServers: vi.fn(async () => [server]),
    getOrCreateTenantSettings: vi.fn(),
    createMcpServer: vi.fn(), updateMcpServer: vi.fn(), disableMcpServer: vi.fn(),
    setMcpServerPublished: vi.fn(), saveMcpServerWithAudience: vi.fn(), setInheritedMcpAudience: vi.fn()
  };
  vi.mocked(dynamicConfig.getOrCreateTenantSettings).mockResolvedValue({ enabledMcpServerIds: [server.serverId] } as Awaited<ReturnType<typeof dynamicConfig.getOrCreateTenantSettings>>);
  await registerAdminMcpServerRoutes(app, {
    dynamicConfig, mcpConnectionTests: { test: run, listLatest }
  });
  return { app, run, listLatest };
}

test("tests only the saved configuration in the authenticated admin scope", async () => {
  const { app, run } = await setup();
  const response = await app.inject({ method: "POST", url, payload });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json()).toEqual({ connectionTest: check });
  expect(run).toHaveBeenCalledExactlyOnceWith("tenant-a", "admin-a", "research", payload);
});

test("rejects members before discovery or reading saved results", async () => {
  const { app, run, listLatest } = await setup(false);
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: "GET", url: "/admin/mcp-servers" })).statusCode).toBe(403);
  expect(run).not.toHaveBeenCalled();
  expect(listLatest).not.toHaveBeenCalled();
});

test("rejects missing snapshots and caller-supplied endpoints or identity", async () => {
  const { app, run } = await setup();
  for (const body of [ {}, { expectedVersion: 3 }, { ...payload, upstreamUrl: "http://127.0.0.1" },
    { ...payload, tenantId: "another-tenant" }, { ...payload, userId: "another-admin" } ]) {
    expect((await app.inject({ method: "POST", url, payload: body })).statusCode).toBe(400);
  }
  expect(run).not.toHaveBeenCalled();
});

test("returns stale configuration and missing server errors without reporting success", async () => {
  const { app, run } = await setup();
  run.mockRejectedValueOnce(new McpConnectionTestConflictError());
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(409);
  run.mockRejectedValueOnce(new McpConnectionTestNotFoundError());
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(404);
});

test("attaches only the current user's saved results while retaining availability", async () => {
  const { app, listLatest } = await setup();
  const response = await app.inject({ method: "GET", url: "/admin/mcp-servers" });
  expect(response.statusCode).toBe(200);
  expect(listLatest).toHaveBeenCalledExactlyOnceWith("tenant-a", "admin-a", [server]);
  expect(response.json().mcpServers).toEqual([{ ...server, isAllowed: true, connectionTest: check }]);
});
