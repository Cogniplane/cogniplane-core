import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, expect, test, vi } from "vitest";

import { McpServerVersionConflictError } from "../../services/mcp-server-store.js";
import type { AdminMcpServerRecord } from "../../services/admin-config-records.js";
import { registerAdminMcpServerRoutes } from "./admin-mcp-server-routes.js";

const SERVER: AdminMcpServerRecord & { ownerTenantId: string } = {
  serverId: "vendor", ownerTenantId: "tenant-1", serverName: "Vendor", description: null, transportKind: "http",
  mode: "proxy", routePath: "/mcp/vendor", upstreamUrl: "https://vendor.example/mcp", upstreamAuthType: "none",
  upstreamAuthName: null, upstreamAuthConfigured: false, credentialScope: "organization",
  credentialBindingId: "00000000-0000-4000-8000-000000000001", version: 4, configHash: "hash", enabled: true,
  isPublished: true, createdBy: "admin-1", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z"
};
const BODY = {
  serverId: "vendor", serverName: "Vendor", mode: "proxy", routePath: "/mcp/vendor",
  upstreamUrl: "https://vendor.example/mcp", audience: "members"
};
const CONFLICT = {
  error: "mcp_server_conflict",
  message: "This connection changed after you opened it. Review the saved connection before you save again."
};

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

async function buildApp(options: { isAdmin?: boolean; save?: (...args: unknown[]) => Promise<unknown> } = {}) {
  const audits: unknown[] = [];
  const save = vi.fn(options.save ?? (async (_tenantId: unknown, input: unknown, audience: unknown, _editing: unknown,
    audit?: (server: AdminMcpServerRecord) => unknown) => {
    const saved = { ...SERVER, ...(input as object), version: SERVER.version + 2, enabled: audience !== "off" };
    audits.push(audit?.(saved as AdminMcpServerRecord));
    return saved;
  }));
  const requireStepUp = vi.fn(async () => true);
  const app = Fastify();
  app.decorate("db", { query: async () => ({ rows: [] }) } as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "admin-1", tenantId: "tenant-1", isAdmin: options.isAdmin ?? true, role: "admin" };
  });
  await registerAdminMcpServerRoutes(app, {
    dataRoutes: { requireStepUp, ownerNotice: vi.fn(() => undefined) },
    dynamicConfig: {
      listMcpServers: vi.fn(async () => [SERVER, { ...SERVER, serverId: "shared", ownerTenantId: "system" }]),
      getOrCreateTenantSettings: vi.fn(async () => ({ enabledMcpServerIds: ["vendor"] })) as never,
      saveMcpServerWithAudience: save as never,
      createMcpServer: vi.fn(),
      updateMcpServer: vi.fn(),
      disableMcpServer: vi.fn(),
      setMcpServerPublished: vi.fn(),
      setInheritedMcpAudience: vi.fn()
    }
  });
  close = () => app.close();
  const put = (payload: unknown, serverId = "vendor") =>
    app.inject({ method: "PUT", url: `/admin/mcp-servers/${serverId}/setup`, payload: payload as object });
  return { app, put, save, requireStepUp, audits };
}

test("an edit sends the saved version that its draft started from", async () => {
  const { put, save } = await buildApp();
  const response = await put({ ...BODY, expectedVersion: 4 });
  expect(response.statusCode, response.body).toBe(200);
  expect(save).toHaveBeenCalledWith(
    "tenant-1",
    expect.not.objectContaining({ expectedVersion: expect.anything() }),
    "members",
    { serverId: "vendor", expectedVersion: 4 },
    expect.any(Function)
  );
});

test.each([
  ["missing", undefined],
  ["zero", 0],
  ["negative", -1],
  ["fractional", 4.5],
  ["string", "4"],
  ["null", null]
])("an edit with a %s expectedVersion answers 400 and saves nothing", async (_name, expectedVersion) => {
  const { put, save, requireStepUp } = await buildApp();
  const response = await put({ ...BODY, expectedVersion });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: "invalid_request" });
  expect(save).not.toHaveBeenCalled();
  expect(requireStepUp).not.toHaveBeenCalled();
});

test("a stale version answers 409 before the step-up check and saves nothing", async () => {
  const { put, save, requireStepUp, audits } = await buildApp();
  const response = await put({ ...BODY, audience: "off", expectedVersion: 3 });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual(CONFLICT);
  expect(requireStepUp).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(audits).toEqual([]);
});

// The pre-check passed, and another save committed before the row lock. The
// integration test shows that the transaction then writes nothing.
test("a newer version found in the transaction answers the same 409", async () => {
  const { put, requireStepUp } = await buildApp({
    save: async () => { throw new McpServerVersionConflictError(); }
  });
  const response = await put({ ...BODY, expectedVersion: 4 });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual(CONFLICT);
  expect(requireStepUp).toHaveBeenCalledTimes(1);
});

test("a missing or inherited connection answers 404 before the version check", async () => {
  const { put, save, requireStepUp } = await buildApp();
  for (const serverId of ["no-such-server", "shared"]) {
    const response = await put({ ...BODY, serverId, expectedVersion: 3 }, serverId);
    expect(response.statusCode).toBe(404);
  }
  expect(save).not.toHaveBeenCalled();
  expect(requireStepUp).not.toHaveBeenCalled();
});

test("a caller who is not an admin gets 403 and no version information", async () => {
  const { put, save } = await buildApp({ isAdmin: false });
  const response = await put({ ...BODY, expectedVersion: 3 });
  expect(response.statusCode).toBe(403);
  expect(response.body).not.toContain("version");
  expect(save).not.toHaveBeenCalled();
});

test("a new connection has no saved version and still saves", async () => {
  const { app, save } = await buildApp();
  const response = await app.inject({
    method: "POST", url: "/admin/mcp-servers/setup", payload: { ...BODY, serverId: "new-one", routePath: "/mcp/new-one" }
  });
  expect(response.statusCode, response.body).toBe(201);
  expect(save).toHaveBeenCalledWith("tenant-1", expect.objectContaining({ serverId: "new-one" }), "members",
    undefined, expect.any(Function));
});
