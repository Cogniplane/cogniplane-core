import { test, expect, vi, onTestFinished } from "vitest";

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

import { DeepAgentsRuntimeAdapter } from "./services/deep-agents/deep-agents-runtime-adapter.js";
import type { DeepAgentsRuntimeFactory } from "./services/deep-agents/deep-agents-types.js";
import { testRuntimePolicy } from "./test-helpers/test-runtime-policy.js";
import { generateRuntimeToken, runtimeTokenExpiry } from "./services/auth/runtime-token.js";

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

test("shutdown waits for scheduled jobs before and after the runtimes close", async () => {
  const app = Fastify();
  const events: string[] = [];
  app.decorate("db", { end: async () => { events.push("database"); } } as unknown as Pool);
  const schedulerWorker = {
    start: () => {},
    stop: () => { events.push("scheduler-stop"); },
    refuseNewTurns: () => { events.push("scheduler-refuse"); },
    drain: async (budgetMs: number) => { events.push(`scheduler-drain:${budgetMs}`); return true; }
  };
  registerAppLifecycle({
    app,
    config: createTestConfig(),
    limits: { sweepExpired: () => {} } as AppDependencies["limits"],
    policyService: { close: async () => {} } as AppDependencies["policyService"],
    runtimeAdapter: { close: async () => { events.push("runtime"); } } as unknown as AppDependencies["runtimeAdapter"],
    turnDrainWaitMs: 5,
    schedulerDrainWaitMs: 40,
    schedulerWorker: schedulerWorker as never
  });
  await app.ready();

  await app.close();

  // The pools close only after scheduled jobs settled.
  // The second wait has its own budget for aborted jobs to write their outcome.
  expect(events).toEqual(["scheduler-stop", "scheduler-drain:5", "scheduler-refuse", "runtime", "scheduler-drain:40", "database"]);
});

async function createRouteTestApp() {
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
          sandboxEgressDomains: [], allowCommandExecution: false,
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

  onTestFinished(() => app.close());
  return { app, deps };
}

test("registerAppRoutes wires health, admin, and settings endpoints", async () => {
  const { app, deps } = await createRouteTestApp();
  await registerAppRoutes(app, deps);
  await app.ready();

  const healthResponse = await app.inject({ method: "GET", url: "/health" });
  expect(healthResponse.statusCode).toBe(200);
  // The unauthenticated health endpoint returns a bare status. Build, uptime
  // and runtime detail live behind GET /admin/diagnostics and
  // GET /admin/runtime-health.
  expect(healthResponse.json()).toEqual({ status: "ok" });

  const diagnosticsResponse = await app.inject({ method: "GET", url: "/admin/diagnostics" });
  expect(diagnosticsResponse.statusCode).toBe(200);
  expect(diagnosticsResponse.json()).toMatchObject({
    status: "ok",
    version: { sha: expect.any(String) },
    runtimes: { activeRuntimeCount: 0, activeTurnCount: 0 }
  });

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

test("app gateway accepts tokens issued by adapter creation and capability refresh", async () => {
  const { app, deps } = await createRouteTestApp();
  const server = { id: "managed-session-context", description: "Session context", mode: "managed" as const,
    routePath: "/mcp/managed-session-context", upstreamUrl: null, transportKind: "http" as const,
    version: 1, hash: "server-v1" };
  let generation = 1;
  deps.dynamicConfig.compileRuntimeConfig = async () => ({
    runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: [server.id] },
    skills: [], mcpServers: [server], hash: `config-${generation}`,
    sources: { runtimePolicy: { id: "test", version: 1, hash: "policy-v1" }, skills: [], mcpServers: [] },
  });
  const lookup = vi.fn(async () => server);
  deps.dynamicConfig.getMcpServerForUser = lookup;
  const outgoing: string[] = [];
  const capture = (servers: Parameters<DeepAgentsRuntimeFactory>[0]["mcpServers"]) => {
    expect(servers).toHaveLength(1);
    outgoing.push(servers![0]!.authorization);
  };
  const factory: DeepAgentsRuntimeFactory = (init) => {
    capture(init.mcpServers);
    return {
      async refreshCapabilities(next) { capture(next.mcpServers); },
      setApprovalSettings() {},
      async getPendingActions() { return []; },
      buildResumeInput() { throw new Error("No approval in this fixture"); },
      getMcpToolNames() { return new Set(); }, getMcpToolServers() { return new Map(); },
      async getAgentForModel() { throw new Error("No model call in this fixture"); },
      async dispose() {},
    };
  };
  const stores = {
    tenantMembers: { isUserBetaTester: async () => false },
    sessions: { getReadable: async () => ({ sessionId: "session-1", userId: "admin-user", status: "active" }) },
    auditEvents: deps.auditEvents,
  } as unknown as ConstructorParameters<typeof DeepAgentsRuntimeAdapter>[3];
  const adapter = new DeepAgentsRuntimeAdapter(app.config, deps.dynamicConfig, app.log, stores, undefined, factory);
  onTestFinished(() => adapter.close());
  const actor = { tenantId: "admin-tenant", userId: "admin-user", sessionId: "session-1" };
  const session = await adapter.createSession(actor);
  generation += 1;
  await adapter.createSession(actor);
  expect(outgoing).toHaveLength(2);
  await registerAppRoutes(app, deps);
  const payload = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  for (const authorization of outgoing) {
    const response = await app.inject({ method: "POST", url: server.routePath, remoteAddress: "127.0.0.1",
      headers: { authorization }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.protocolVersion).toBeTruthy();
    expect(lookup).toHaveBeenLastCalledWith(actor.tenantId, server.id, actor.userId);
  }
  const wrongKeyToken = generateRuntimeToken({ tid: actor.tenantId, uid: actor.userId,
    sid: actor.sessionId, rid: session.runtimeId, exp: runtimeTokenExpiry(60_000) }, app.config.DATA_ENCRYPTION_SECRET);
  const denied = await app.inject({ method: "POST", url: server.routePath, remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${wrongKeyToken}` }, payload });
  expect(denied.statusCode).toBe(401);
  expect(lookup).toHaveBeenCalledTimes(2);
});
