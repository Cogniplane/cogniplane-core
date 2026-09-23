import { test, expect, vi } from "vitest";

import Fastify from "fastify";

import { get } from "node:http";

import { registerAppLifecycle, registerAppRoutes } from "./app-bootstrap.js";
import { createTestConfig } from "./test-helpers/test-config.js";
import { FakeDatabase } from "./test-helpers/fake-database.js";
import type { Pool } from "./lib/db.js";
import type { buildAppDependencies } from "./app-dependencies.js";
import { ManagedToolCatalog } from "./services/managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "./services/managed-tools/factory.js";
import { registerBuiltinManagedTools } from "./services/managed-tools/register-builtin-managed-tools.js";
import { ActiveTurnsRegistry } from "./services/active-turns-registry.js";

type AppDependencies = ReturnType<typeof buildAppDependencies>;

test("shutdown aborts a live hijacked SSE connection before waiting for server close", async () => {
  const app = Fastify();
  const events: string[] = [];
  let endStream = () => {};
  app.decorate("db", { end: async () => { events.push("database"); } } as unknown as Pool);
  app.get("/stream", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    reply.raw.write("data: started\n\n");
    endStream = () => reply.raw.end();
  });
  registerAppLifecycle({
    app,
    config: createTestConfig(),
    limits: { sweepExpired: () => {} } as AppDependencies["limits"],
    policyService: { close: async () => { events.push("policy"); } } as AppDependencies["policyService"],
    runtimeAdapter: { close: async () => { events.push("runtime"); endStream(); } } as AppDependencies["runtimeAdapter"],
    schedulerWorker: null
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    get(`${address}/stream`, resolve).on("error", reject);
  });
  response.resume();
  try {
    await app.close();
    expect(events).toEqual(["runtime", "policy", "database"]);
  } finally {
    response.destroy();
    endStream();
    await app.close();
  }
});

test("shutdown refuses new turns, interrupts a stuck turn, and saves its status before closing the database", async () => {
  const app = Fastify();
  const events: string[] = [];
  const activeTurns = new ActiveTurnsRegistry();
  activeTurns.mark("session-1", { tenantId: "tenant-1", userId: "user-1" });
  activeTurns.identify("session-1", { messageId: "message-1", sequence: 1 });
  app.decorate("db", { end: async () => { events.push("database"); } } as unknown as Pool);
  registerAppLifecycle({
    app,
    config: createTestConfig(),
    limits: { sweepExpired: () => {} } as AppDependencies["limits"],
    policyService: { close: async () => {} } as AppDependencies["policyService"],
    runtimeAdapter: {
      interruptTurn: async () => { events.push("interrupt"); return "interrupted"; },
      close: async () => { events.push("runtime"); }
    } as unknown as AppDependencies["runtimeAdapter"],
    activeTurns,
    messages: { markInterruptedIfActive: async () => { events.push("message"); } },
    turnDrainWaitMs: 5,
    schedulerWorker: null
  });
  await app.ready();

  await app.close();

  expect(activeTurns.isDraining()).toBe(true);
  expect(activeTurns.cancelSignal("session-1")?.aborted).toBe(true);
  expect(events).toEqual(["interrupt", "message", "runtime", "database"]);
});

test("registerAppRoutes wires health, admin, and settings endpoints", async () => {
  const app = Fastify();

  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "admin-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  vi.spyOn(app.db, "query").mockResolvedValue({ rows: [], rowCount: 1 } as never);
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
          approvalPolicy: "on-request" as const,
          approvalReviewer: "user" as const, sandboxMode: "workspace-write" as const,
          networkMode: "restricted" as const, allowCommandExecution: false,
          autoApproveReadOnlyTools: true,
          developerInstructions: null, enabledToolIds: [], enabledMcpServers: [],
          version: 1, hash: "test"
        };
      },
      async getOrCreateTenantSettings() {
        return {
          tenantId: "admin-tenant",
          showEffortSelector: false,
          approvalPolicy: "on-request",
          approvalReviewer: "user",
          allowCommandExecution: false,
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
          showEffortSelector: false,
          approvalPolicy: "on-request",
          approvalReviewer: "user",
          allowCommandExecution: false,
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
    runtimeAdapter: {
      hasActiveTurn: () => false,
      async invalidateTenantRuntimes() {
        return [];
      }
    },
    deepAgentsAdapter: {
      getHealthSnapshot() {
        return { activeRuntimeCount: 0, activeTurnCount: 0 };
      },
      getRuntimeHealthDetail() {
        return [];
      },
      async invalidateTenantRuntimes() {
        return [];
      }
    },
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
