import { expect, test, vi } from "vitest";
import type { AdminMcpServerRecord } from "../admin-config-records.js";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { McpConnectionTestService } from "./mcp-connection-test-service.js";

const server: AdminMcpServerRecord = {
  serverId: "research", ownerTenantId: "tenant-a", serverName: "Research", description: null,
  transportKind: "http", mode: "proxy", routePath: "/mcp/research", upstreamUrl: "https://example.test/mcp",
  upstreamAuthType: "bearer", upstreamAuthName: null, upstreamAuthConfigured: true,
  credentialScope: "organization", credentialBindingId: "binding", version: 3, configHash: "a".repeat(64),
  enabled: true, isPublished: true, createdBy: "admin-a", createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z"
};
const row = {
  tenant_id: "tenant-a", server_id: server.serverId, scope_user_id: "", owner_tenant_id: "tenant-a",
  config_hash: server.configHash, config_version: 3, credential_binding_id: null, credential_version: null,
  checked_at: server.updatedAt, reachability: "reachable", authentication: "accepted",
  tool_discovery: "succeeded", tool_count: 2, message: "Discovery completed."
};

function setup(rows: Record<string, unknown>[], credentialVersion = 4) {
  const pool = new FakePool().onQuery("SELECT * FROM admin_mcp_connection_tests", (_sql, params) => {
    expect(params).toEqual(["tenant-a", [server.serverId], "admin-a"]);
    return { rows, rowCount: rows.length };
  });
  const getStatus = vi.fn(async () => ({ status: "connected" as const, credentialVersion, accountLabel: null }));
  const listStatuses = vi.fn(async (_tenant: string, _user: string, servers: readonly { serverId: string }[]) =>
    new Map(servers.map(item => [item.serverId, { status: "connected" as const, credentialVersion, accountLabel: null }])));
  const service = new McpConnectionTestService({
    db: pool.asPool(), servers: { getAdminMcpServer: vi.fn(async () => null), getMcpServer: vi.fn(async () => null) },
    credentials: { getStatus, listStatuses, getRuntimeCredential: vi.fn(async () => null) },
    timeoutMs: 8_000
  });
  return { service, pool, getStatus, listStatuses };
}

test("returns current organization results without inspecting personal credentials", async () => {
  const { service, getStatus, listStatuses } = setup([row]);
  const result = await service.listLatest("tenant-a", "admin-a", [server]);
  expect(result.get(server.serverId)).toMatchObject({
    configVersion: 3, credentialScope: "organization", testedUserId: null, toolCount: 2
  });
  expect(getStatus).not.toHaveBeenCalled();
  expect(listStatuses).not.toHaveBeenCalled();
});

test("hides tests for replaced, edited, or missing configurations", async () => {
  for (const rows of [[], [{ ...row, owner_tenant_id: "system" }],
    [{ ...row, config_hash: "b".repeat(64) }], [{ ...row, config_version: 2 }]]) {
    const { service } = setup(rows);
    expect((await service.listLatest("tenant-a", "admin-a", [server])).size).toBe(0);
  }
  const { service, pool } = setup([]);
  expect((await service.listLatest("tenant-a", "admin-a", [])).size).toBe(0);
  expect(pool.queries).toHaveLength(0);
});

test("returns only the current tester's personal result", async () => {
  const personal = { ...server, credentialScope: "personal" as const };
  const personalRow = { ...row, scope_user_id: "admin-a", credential_binding_id: "binding", credential_version: 4 };
  const { service, listStatuses } = setup([row, personalRow, { ...personalRow, scope_user_id: "admin-b", tool_count: 99 }]);
  const result = await service.listLatest("tenant-a", "admin-a", [personal]);
  expect(listStatuses).toHaveBeenCalledTimes(1);
  expect(result.get(server.serverId)).toMatchObject({ credentialScope: "personal", testedUserId: "admin-a", toolCount: 2 });
  for (const override of [{ credential_binding_id: "old-binding" }, { credential_version: 3 }]) {
    const stale = setup([{ ...personalRow, ...override }]);
    expect((await stale.service.listLatest("tenant-a", "admin-a", [personal])).size).toBe(0);
  }
});

test("retains a missing-credential result until the member saves a credential", async () => {
  const missing = { ...row, scope_user_id: "admin-a", credential_binding_id: "binding", credential_version: 0,
    tool_count: null, authentication: "credential_missing", tool_discovery: "not_tested", reachability: "unknown" };
  const personal = { ...server, credentialScope: "personal" as const };
  const before = setup([missing], 0);
  expect((await before.service.listLatest("tenant-a", "admin-a", [personal])).get(server.serverId))
    .toMatchObject({ authentication: "credential_missing", toolCount: null });
  const after = setup([missing], 1);
  expect((await after.service.listLatest("tenant-a", "admin-a", [personal])).size).toBe(0);
});
