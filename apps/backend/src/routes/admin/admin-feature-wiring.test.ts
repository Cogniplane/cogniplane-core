import Fastify from "fastify";
import { expect, onTestFinished, test, vi } from "vitest";

import type { Pool } from "../../lib/db.js";
import type { AdminMcpServerRecord } from "../../services/admin-config-records.js";
import { devDataRoutes } from "../../test-helpers/data-routes.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import { buildAdminMcpServerRouteStores, registerAdminMcpServerRoutes } from "./admin-mcp-server-routes.js";
import { buildAdminSkillRouteStores, registerAdminSkillRoutes } from "./admin-skill-routes.js";

// Each admin feature builds its dependencies from the app dependencies that it
// names. These tests give a feature only those, so they fail when its wiring
// drops one or starts to need the dependency of another feature.

function adminApp() {
  const app = Fastify();
  onTestFinished(() => app.close());
  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-a" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId: "tenant-a", userId: "admin-a", isAdmin: true, role: "owner" };
  });
  return app;
}

const server = {
  serverId: "research", ownerTenantId: "tenant-a", serverName: "Research", version: 3, enabled: true
} as AdminMcpServerRecord;

test("MCP server routes work with the MCP dependencies only", async () => {
  type McpDeps = Parameters<typeof buildAdminMcpServerRouteStores>[0];
  const connectionTest = { serverId: server.serverId, toolCount: 2 };
  const deps = {
    mcpAdmin: {
      listMcpServers: vi.fn(async () => [server]),
      listAllowedMcpServerIds: vi.fn(async () => [server.serverId])
    },
    activationTracker: {
      countMcpServerActivations: vi.fn(async () =>
        new Map([[server.serverId, { invokedSessions: 4, materializedSessions: 5 }]]))
    },
    mcpConnectionTests: { listLatest: vi.fn(async () => new Map([[server.serverId, connectionTest]])) },
    mcpAppCsp: { listForAdmin: vi.fn(async () => []) }
  };
  const dataRoutes = devDataRoutes();
  const stores = buildAdminMcpServerRouteStores(deps as unknown as McpDeps, { dataRoutes });

  expect(Object.keys(stores).sort()).toEqual(["activations", "dataRoutes", "mcpAdmin", "mcpAppCsp", "mcpConnectionTests"]);
  expect(stores.dataRoutes).toBe(dataRoutes);

  const app = adminApp();
  await registerAdminMcpServerRoutes(app, stores);
  const response = await app.inject({ method: "GET", url: "/admin/mcp-servers" });

  expect(response.statusCode).toBe(200);
  expect(response.json().mcpServers).toEqual([
    expect.objectContaining({ serverId: "research", isAllowed: true, connectionTest })
  ]);
  expect(deps.mcpAdmin.listMcpServers).toHaveBeenCalledExactlyOnceWith("tenant-a");
  expect(deps.mcpConnectionTests.listLatest).toHaveBeenCalledExactlyOnceWith("tenant-a", "admin-a", [server]);
  expect(deps.activationTracker.countMcpServerActivations).toHaveBeenCalledOnce();
});

test("skill routes get the release impact store and the tenant marketplace address", async () => {
  type SkillDeps = Parameters<typeof buildAdminSkillRouteStores>[0];
  const snapshot = { version: 1, activeRevisionId: null, latestRevisionId: 2, enabled: false, isPublished: false };
  const preview = vi.fn(async (_tenantId: string, skillId: string) => ({
    skillId, snapshot,
    current: { revisionId: null, revisionNumber: null, audience: "off" },
    proposed: { revisionId: 2, revisionNumber: 1, audience: "members" },
    members: { total: 3, testUsers: 1, gaining: 3, losing: 0 },
    configuredReferences: {
      projects: { inherited: 0, explicitSelected: 1 },
      personalDefaults: { inherited: 2, explicitSelected: 0 },
      sessions: { inherited: 1, explicitSelected: 0 }
    }
  }));
  const deps = {
    dynamicConfig: {}, skillMarketplace: {}, auditEvents: { create: vi.fn() }, skillBundleStorage: {},
    githubConnectionService: {}, activationTracker: {},
    skillReleaseImpact: { preview },
    tenantOrgSettings: { get: vi.fn(async () => ({ skillMarketplaceManifestUrl: "https://example.test/marketplace.json" })) }
  };
  const stores = buildAdminSkillRouteStores(deps as unknown as SkillDeps, { dataRoutes: devDataRoutes() });

  await expect(stores.tenantSettings?.getMarketplaceManifestUrl("tenant-a"))
    .resolves.toBe("https://example.test/marketplace.json");

  const app = adminApp();
  await registerAdminSkillRoutes(app, stores);
  const payload = { action: "activate", revisionId: 2, audience: "members" };
  const response = await app.inject({ method: "POST", url: "/admin/skills/test-skill/release-impact", payload });

  expect(response.statusCode).toBe(200);
  expect(response.json().snapshot).toEqual(snapshot);
  expect(preview).toHaveBeenCalledExactlyOnceWith("tenant-a", "test-skill", payload);
});
