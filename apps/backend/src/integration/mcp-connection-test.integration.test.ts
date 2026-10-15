import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import { forwardRpc, rpcOk } from "../lib/mcp-upstream-client.js";
import { MemberMcpCredentialStore } from "../services/member-mcp-credential-store.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import {
  McpConnectionTestConflictError,
  McpConnectionTestService
} from "../services/mcp/mcp-connection-test-service.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenantGraph, seedUser } from "./support/fixtures.js";

const secret = "integration-test-connection-encryption-secret";
const stores = () => ({
  servers: new McpServerStore(appPool(), secret),
  credentials: new MemberMcpCredentialStore(appPool(), secret)
});
function service(forward?: typeof forwardRpc) {
  const { servers, credentials } = stores();
  return new McpConnectionTestService({
    db: appPool(), servers, credentials,
    timeoutMs: 8_000, ...(forward ? { forward } : {})
  });
}

describe.skipIf(!adminDatabaseUrl())("admin MCP connection tests", () => {
  test("persists a tenant-scoped result and hides it after a saved configuration change", async () => {
    const first = await seedTenantGraph();
    const second = await seedTenantGraph();
    const serverId = `local-${randomUUID()}`;
    const { servers } = stores();
    const saved = await servers.createMcpServer(first.tenantId, {
      serverId, serverName: "Local tools", description: null, transportKind: "http",
      mode: "managed", routePath: `/mcp/${serverId}`, upstreamUrl: null,
      upstreamAuthType: "none", upstreamAuthName: null, upstreamAuthSecret: null,
      enabled: true, createdBy: first.userId
    });
    const tester = service();
    const result = await tester.test(first.tenantId, first.userId, serverId, {
      expectedVersion: saved.version, expectedConfigHash: saved.configHash
    });
    expect(result).toMatchObject({ serverId, configHash: saved.configHash,
      toolDiscovery: "succeeded", reachability: "unknown", toolCount: null });
    expect((await tester.listLatest(first.tenantId, first.userId, [saved])).get(serverId))
      .toMatchObject({ checkedAt: result.checkedAt });
    const raw = await superuserPool().query(
      "SELECT * FROM admin_mcp_connection_tests WHERE tenant_id=$1 AND server_id=$2",
      [first.tenantId, serverId]
    );
    expect(raw.rows).toHaveLength(1);
    expect((await tester.listLatest(second.tenantId, second.userId, [saved])).size).toBe(0);
    const changed = await servers.updateMcpServer(first.tenantId, {
      serverId, serverName: "Renamed local tools", description: null,
      transportKind: "http", mode: "managed", routePath: saved.routePath, enabled: true
    });
    expect(changed?.configHash).not.toBe(saved.configHash);
    expect((await tester.listLatest(first.tenantId, first.userId, [changed!])).size).toBe(0);
    await expect(tester.test(first.tenantId, first.userId, serverId, {
      expectedVersion: saved.version, expectedConfigHash: saved.configHash
    })).rejects.toBeInstanceOf(McpConnectionTestConflictError);
  });

  test("personal results follow the testing user and credential version", async () => {
    const tenant = await seedTenantGraph();
    const other = await seedUser();
    await seedMembership(tenant.tenantId, other);
    const serverId = `personal-${randomUUID()}`;
    const { servers, credentials } = stores();
    await servers.createMcpServer(tenant.tenantId, {
      serverId, serverName: "Personal proxy", description: null,
      transportKind: "http", mode: "proxy", routePath: `/mcp/${serverId}`,
      upstreamUrl: "https://vendor.example/mcp", upstreamAuthType: "header",
      upstreamAuthName: "X-Api-Key", upstreamAuthSecret: null,
      credentialScope: "personal", enabled: true, createdBy: tenant.userId
    });
    await servers.setMcpServerPublished(tenant.tenantId, serverId, true);
    await new TenantSettingsStore(appPool()).upsert(tenant.tenantId, {
      enabledMcpServerIds: [serverId]
    });
    const saved = (await servers.getAdminMcpServer(tenant.tenantId, serverId))!;
    await credentials.save(tenant.tenantId, tenant.userId, serverId, {
      version: 0, serverVersion: saved.version, secret: "first-personal-secret", accountLabel: null
    });
    const forward = vi.fn(async (_url, request) => rpcOk(request.id, {
      tools: [{ name: "search", inputSchema: { type: "object" } }]
    }));
    const tester = service(forward as never);
    const check = await tester.test(tenant.tenantId, tenant.userId, serverId, {
      expectedVersion: saved.version, expectedConfigHash: saved.configHash
    });
    expect(check).toMatchObject({ credentialScope: "personal", testedUserId: tenant.userId,
      toolDiscovery: "succeeded", toolCount: 1 });
    expect(JSON.stringify(check)).not.toContain("first-personal-secret");
    expect((await tester.listLatest(tenant.tenantId, other, [saved])).size).toBe(0);
    expect((await tester.listLatest(tenant.tenantId, tenant.userId, [saved])).size).toBe(1);
    await credentials.save(tenant.tenantId, tenant.userId, serverId, {
      version: 1, serverVersion: saved.version, secret: "new-personal-secret", accountLabel: null
    });
    expect((await tester.listLatest(tenant.tenantId, tenant.userId, [saved])).size).toBe(0);
  });
});
