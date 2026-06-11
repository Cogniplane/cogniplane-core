import { test, expect } from "vitest";

import Fastify from "fastify";

import { registerAppRoutes } from "./app-bootstrap.js";
import { createTestConfig } from "./test-helpers/test-config.js";
import { FakeDatabase } from "./test-helpers/fake-database.js";
import type { Pool } from "./lib/db.js";
import type { buildAppDependencies } from "./app-dependencies.js";
import { ManagedToolCatalog } from "./services/managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "./services/managed-tools/factory.js";
import { registerBuiltinManagedTools } from "./services/managed-tools/register-builtin-managed-tools.js";

type AppDependencies = ReturnType<typeof buildAppDependencies>;

test("registerAppRoutes wires health, admin, and settings endpoints", async () => {
  const app = Fastify();

  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "admin-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const deps = {
    sessions: {},
    messages: {},
    artifacts: {},
    runtimeSessions: {
      async listRecent(_tenantId: string) {
        return [];
      }
    },
    skills: {},
    skillRevisions: {},
    mcpServers: {},
    tenantSettings: {},
    userSettings: {
      async listSections() {
        return [];
      }
    },
    approvals: {},
    auditEvents: {
      async create() {}
    },
    toolEvents: {},
    toolContexts: {},
    skillBundleStorage: {},
    dynamicConfig: {
      async listSkills() {
        return [];
      },
      async disableSkill() {
        return null;
      },
      async importSkillBundleFromZip() {
        throw new Error("Not implemented in test.");
      },
      async importSkillBundleFromGithub() {
        throw new Error("Not implemented in test.");
      },
      async listSkillRevisions() {
        return [];
      },
      async getSkillRevision() {
        return null;
      },
      async activateSkillRevision() {
        throw new Error("Not implemented in test.");
      },
      async cleanupInactiveSkillRevisions() {
        return { dryRun: false, deletedRevisionIds: [], deletedBundleStorageUris: [], keptRevisionDecisions: [], failures: [] };
      },
      async listMcpServers() {
        return [];
      },
      async createMcpServer() {
        throw new Error("Not implemented in test.");
      },
      async updateMcpServer() {
        return null;
      },
      async disableMcpServer() {
        return null;
      },
      async getRuntimePolicy() {
        return {
          id: "tenant-settings:admin-tenant", label: "Tenant Settings", description: null,
          runtimeProvider: "codex" as const, approvalPolicy: "on-request" as const,
          approvalReviewer: "user" as const, sandboxMode: "workspace-write" as const,
          networkMode: "restricted" as const, allowCommandExecution: false,
          allowUserTokenForwarding: true, autoApproveReadOnlyTools: true,
          developerInstructions: null, enabledToolIds: [], enabledMcpServers: [],
          version: 1, hash: "test"
        };
      },
      async getOrCreateTenantSettings() {
        return {
          tenantId: "admin-tenant",
          runtimeProvider: "codex" as const,
          enabledRuntimeProviders: ["codex"] as const,
          showEffortSelector: false,
          approvalPolicy: "on-request",
          approvalReviewer: "user",
          allowCommandExecution: false,
          allowUserTokenForwarding: true,
          autoApproveReadOnlyTools: true,
          developerInstructions: null,
          enabledToolIds: [],
          enabledMcpServerIds: [],
          version: 1,
          configHash: "",
          updatedAt: new Date().toISOString()
        };
      },
      async updateTenantSettings() {
        return {
          tenantId: "admin-tenant",
          runtimeProvider: "codex" as const,
          enabledRuntimeProviders: ["codex"] as const,
          showEffortSelector: false,
          approvalPolicy: "on-request",
          approvalReviewer: "user",
          allowCommandExecution: false,
          allowUserTokenForwarding: true,
          autoApproveReadOnlyTools: true,
          developerInstructions: null,
          enabledToolIds: [],
          enabledMcpServerIds: [],
          version: 1,
          configHash: "",
          updatedAt: new Date().toISOString()
        };
      },
      async setSkillPublished() {
        return null;
      },
      async setMcpServerPublished() {
        return null;
      }
    },
    tenantMembers: {
      async listTenantMembers() { return []; },
      async setUserBetaTester() { return null; }
    },
    limits: {},
    artifactStorage: {},
    artifactProcessor: {},
    runtimeManager: {
      getHealthSnapshot() {
        return { activeRuntimeCount: 0, activeTurnCount: 0 };
      },
      getRuntimeHealthDetail() {
        return [];
      },
      async refreshIdleRuntimes() {
        return [];
      }
    },
    runtimeAdapters: {},
    overlays: { attachRoutes: () => {} },
    managedToolCatalog: (() => {
      const catalog = new ManagedToolCatalog();
      registerBuiltinManagedTools(catalog, new ManagedToolFactoryRegistry());
      return catalog;
    })(),
    managedToolFactoryRegistry: (() => {
      const factoryRegistry = new ManagedToolFactoryRegistry();
      registerBuiltinManagedTools(new ManagedToolCatalog(), factoryRegistry);
      return factoryRegistry;
    })()
  } as unknown as AppDependencies;

  await registerAppRoutes(app, deps);
  await app.ready();

  const healthResponse = await app.inject({ method: "GET", url: "/health" });
  expect(healthResponse.statusCode).toBe(200);
  expect(healthResponse.json().status).toBe("ok");
  // The unauthenticated health endpoint exposes aggregate counts only —
  // per-runtime detail (sessionId/runtimeId/port) is cross-tenant data and
  // lives behind GET /admin/runtime-health.
  expect(healthResponse.json().runtimes).toEqual({ activeRuntimeCount: 0, activeTurnCount: 0 });

  const adminResponse = await app.inject({ method: "GET", url: "/admin/skills" });
  expect(adminResponse.statusCode).toBe(200);
  expect(adminResponse.json()).toEqual({ skills: [] });

  const settingsResponse = await app.inject({ method: "GET", url: "/me/settings" });
  expect(settingsResponse.statusCode).toBe(200);
  expect(settingsResponse.json().sections).toEqual([
        {
          sectionKey: "scheduled_jobs",
          title: "Scheduled jobs",
          status: "live",
          version: 0,
          config: {},
          updatedAt: null
        },
        {
          sectionKey: "github",
          title: "GitHub",
          status: "live",
          version: 0,
          config: {},
          updatedAt: null
        },
        {
          sectionKey: "skills",
          title: "Skill selection",
          status: "planned",
          version: 0,
          config: {},
          updatedAt: null
        },
        {
          sectionKey: "mcp",
          title: "MCP selection",
          status: "planned",
          version: 0,
          config: {},
          updatedAt: null
        },
        {
          sectionKey: "model",
          title: "Model override",
          status: "planned",
          version: 0,
          config: {},
          updatedAt: null
        }
      ]);

  await app.close();
});
