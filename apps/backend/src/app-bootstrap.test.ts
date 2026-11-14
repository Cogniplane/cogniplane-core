import { describe, test, expect, vi, onTestFinished } from "vitest";

import Fastify, { type FastifyServerOptions } from "fastify";

import { randomUUID } from "node:crypto";
import { get, type IncomingMessage } from "node:http";

import {
  FASTIFY_SHUTDOWN_OPTIONS,
  registerAppLifecycle,
  registerAppRoutes,
  stopRemoteExecution
} from "./app-bootstrap.js";
import { createTestConfig } from "./test-helpers/test-config.js";
import { FakeDatabase } from "./test-helpers/fake-database.js";
import type { Pool } from "./lib/db.js";
import type { buildAppDependencies } from "./app-dependencies.js";
import { ManagedToolCatalog } from "./services/managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "./services/managed-tools/factory.js";
import { registerAllBuiltinManagedTools } from "./test-helpers/builtin-managed-tools.js";
import { ActiveTurnsRegistry } from "./services/active-turns-registry.js";

import { DeepAgentsRuntimeAdapter } from "./services/deep-agents/deep-agents-runtime-adapter.js";
import type { DeepAgentsRuntimeFactory } from "./services/deep-agents/deep-agents-types.js";
import { testRuntimePolicy } from "./test-helpers/test-runtime-policy.js";
import { generateRuntimeToken, runtimeTokenExpiry } from "./services/auth/runtime-token.js";
import { devDataRoutes } from "./test-helpers/data-routes.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerLocalAuthRoutes } from "./routes/auth-local.js";
import { SHUTDOWN_STAGE_MS } from "./lib/shutdown-budget.js";
import type { LocalAuth } from "./services/auth/local-auth.js";

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
    shutdownStageMs: { turnWait: 5, turnInterrupt: 5 },
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
    shutdownStageMs: { schedulerDrain: 5, schedulerSettle: 40 },
    schedulerWorker: schedulerWorker as never
  });
  await app.ready();

  await app.close();

  // The pools close only after scheduled jobs settled.
  // The second wait has its own budget for aborted jobs to write their outcome.
  expect(events).toEqual(["scheduler-stop", "scheduler-drain:5", "scheduler-refuse", "runtime", "scheduler-drain:40", "database"]);
});

test("the lease sweep also closes orphaned replies, and the runtime owner sweep renews this process first", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const app = Fastify();
  app.decorate("db", { end: async () => {} } as unknown as Pool);
  const calls: string[] = [];
  const config = createTestConfig({ SESSION_EXECUTION_LEASE_MS: 30_000, SESSION_EXECUTION_HEARTBEAT_MS: 5_000 });
  const sweepOrphanedReplies = vi.fn(async (_olderThanMs: number) => { calls.push("replies"); return 0; });
  try {
    registerAppLifecycle({
      app, config,
      limits: { sweepExpired: () => {} } as AppDependencies["limits"],
      policyService: { close: async () => {} } as AppDependencies["policyService"],
      runtimeAdapter: { close: async () => {} } as unknown as AppDependencies["runtimeAdapter"],
      schedulerWorker: null,
      expiredExecutions: { sweepExpired: async () => { calls.push("leases"); return 0; }, sweepOrphanedReplies },
      runtimeOwners: {
        heartbeatOwner: async () => { calls.push("owner"); },
        sweepOrphaned: async () => { calls.push("runtimes"); return 0; }
      }
    });
    await vi.advanceTimersByTimeAsync(0);
    expect([...calls].sort()).toEqual(["leases", "owner", "replies", "runtimes"]);
    expect(calls.indexOf("leases")).toBeLessThan(calls.indexOf("replies"));
    expect(calls.indexOf("owner")).toBeLessThan(calls.indexOf("runtimes"));
    // A reply with no write for one lease period, after the expired leases are closed.
    expect(sweepOrphanedReplies).toHaveBeenCalledWith(30_000);

    calls.length = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual(["leases", "replies"]);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(55_000);
    expect(calls.filter(call => call === "owner" || call === "runtimes")).toEqual(["owner", "runtimes"]);
  } finally {
    await app.close();
    vi.useRealTimers();
  }
});

async function createRouteTestApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

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
    builtinConnectors: {
      attachRoutes: (routeApp: typeof app) => {
        routeApp.get("/me/test-connector", async () => ({ attached: true }));
      }
    },
    overlays: { attachRoutes: () => {} },
    managedToolCatalog: (() => {
      const catalog = new ManagedToolCatalog();
      registerAllBuiltinManagedTools(catalog, new ManagedToolFactoryRegistry());
      return catalog;
    })(),
    managedToolFactoryRegistry: (() => {
      const factoryRegistry = new ManagedToolFactoryRegistry();
      registerAllBuiltinManagedTools(new ManagedToolCatalog(), factoryRegistry);
      return factoryRegistry;
    })()
  } as unknown as AppDependencies;

  onTestFinished(() => app.close());
  return { app, deps };
}

test("registerAppRoutes wires health, admin, and settings endpoints", async () => {
  const { app, deps } = await createRouteTestApp();
  await registerAppRoutes(app, deps, { dataRoutes: devDataRoutes() });
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

  // Built-in connector routes attach with the core route groups.
  const connectorResponse = await app.inject({ method: "GET", url: "/me/test-connector" });
  expect(connectorResponse.json()).toEqual({ attached: true });

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

/** A managed MCP server, and runtime tokens that a real adapter issued for it. */
async function gatewayFixture(app: Awaited<ReturnType<typeof createRouteTestApp>>["app"], deps: AppDependencies) {
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
  const payload = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const wrongKeyToken = generateRuntimeToken({ tid: actor.tenantId, uid: actor.userId,
    sid: actor.sessionId, rid: session.runtimeId, exp: runtimeTokenExpiry(60_000) }, app.config.DATA_ENCRYPTION_SECRET);
  return { server, payload, outgoing, lookup, actor, wrongAuthorization: `Bearer ${wrongKeyToken}` };
}

test("app gateway accepts tokens issued by adapter creation and capability refresh", async () => {
  const { app, deps } = await createRouteTestApp();
  const { server, payload, outgoing, lookup, actor, wrongAuthorization } = await gatewayFixture(app, deps);
  await registerAppRoutes(app, deps, { dataRoutes: devDataRoutes() });
  for (const authorization of outgoing) {
    const response = await app.inject({ method: "POST", url: server.routePath, remoteAddress: "127.0.0.1",
      headers: { authorization }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.protocolVersion).toBeTruthy();
    expect(lookup).toHaveBeenLastCalledWith(actor.tenantId, server.id, actor.userId);
  }
  const denied = await app.inject({ method: "POST", url: server.routePath, remoteAddress: "127.0.0.1",
    headers: { authorization: wrongAuthorization }, payload });
  expect(denied.statusCode).toBe(401);
  expect(lookup).toHaveBeenCalledTimes(2);
});

// The stop route fences the lease on any replica and publishes the stop. The
// replica that owns the lease interrupts its local turn of that execution.
describe("remote Stop", () => {
  const signal = { tenantId: "tenant", sessionId: "session", userId: "user", executionId: "execution-1", ownerId: "replica-a" };
  function remoteStopDeps(input: { stopped?: boolean; requestSlot?: ActiveTurnsRegistry; runtimeTurn?: boolean } = {}) {
    const interruptTurn = vi.fn(async () => "interrupted" as const);
    const isStopped = vi.fn(async () => input.stopped ?? true);
    return {
      deps: {
        executions: { ownerId: "replica-a", isStopped },
        activeTurns: input.requestSlot ?? new ActiveTurnsRegistry(),
        runtimeAdapter: { hasActiveTurn: () => input.runtimeTurn ?? false, interruptTurn }
      },
      interruptTurn,
      isStopped
    };
  }

  test("interrupts a scheduled turn that has a runtime turn but no request slot, by its execution", async () => {
    const { deps, interruptTurn } = remoteStopDeps({ runtimeTurn: true });
    await stopRemoteExecution(deps, signal);
    expect(interruptTurn).toHaveBeenCalledExactlyOnceWith({
      tenantId: "tenant", sessionId: "session", userId: "user", executionId: "execution-1"
    });
  });

  test("cancels the request slot of an interactive turn and interrupts it by its execution", async () => {
    const requestSlot = new ActiveTurnsRegistry();
    requestSlot.mark("session", { tenantId: "tenant", userId: "user" });
    requestSlot.setExecution("session", "execution-1");
    const { deps, interruptTurn } = remoteStopDeps({ requestSlot });
    await stopRemoteExecution(deps, signal);
    expect(requestSlot.cancelSignal("session")?.aborted).toBe(true);
    expect(interruptTurn).toHaveBeenCalledWith(expect.objectContaining({ executionId: "execution-1" }));
  });

  test("ignores a stop for another replica, a lease that is not stopped, and a session with no turn here", async () => {
    const otherOwner = remoteStopDeps({ runtimeTurn: true });
    await stopRemoteExecution(otherOwner.deps, { ...signal, ownerId: "replica-b" });
    expect(otherOwner.isStopped).not.toHaveBeenCalled();
    expect(otherOwner.interruptTurn).not.toHaveBeenCalled();

    const notStopped = remoteStopDeps({ stopped: false, runtimeTurn: true });
    await stopRemoteExecution(notStopped.deps, signal);
    expect(notStopped.interruptTurn).not.toHaveBeenCalled();

    const noTurn = remoteStopDeps({ runtimeTurn: false });
    await stopRemoteExecution(noTurn.deps, signal);
    expect(noTurn.interruptTurn).not.toHaveBeenCalled();
  });
});

/** Opens a GET stream and resolves at its first chunk. */
async function openStream(url: string): Promise<{ response: IncomingMessage; ended: Promise<void>; body: () => string }> {
  const chunks: string[] = [];
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(url, resolve).on("error", reject);
  });
  const ended = new Promise<void>((resolve) => {
    response.on("end", resolve);
    response.on("close", resolve);
  });
  await new Promise<void>((resolve) => {
    response.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString());
      resolve();
    });
  });
  return { response, ended, body: () => chunks.join("") };
}

/** Deps with which POST /messages reaches its drain check for `sessionId`. */
async function prepareMessageRoute(deps: AppDependencies, activeTurns: ActiveTurnsRegistry) {
  const sessionId = randomUUID();
  const tenantSettings = await deps.dynamicConfig.getOrCreateTenantSettings("admin-tenant");
  deps.dynamicConfig.getOrCreateTenantSettings = async () => ({
    ...tenantSettings, enabledProviders: ["anthropic", "openai", "google"], enabledModelIds: null, modelDefaultEfforts: {}
  }) as never;
  Object.assign(deps, {
    activeTurns,
    providerCredentials: { hasKey: async () => true },
    customModels: { list: async () => [] },
    sessions: {
      getReadable: async () => ({
        sessionId, userId: "admin-user", status: "active", purpose: "normal",
        transcriptFormat: "current", sessionName: "Chat"
      })
    }
  });
  return sessionId;
}

function httpClient(address: string) {
  return (url: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${address}${url}`, body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("graceful shutdown", () => {
  test("while turns drain, the gateway answers with its authentication and POST /messages refuses new turns", async () => {
    const { app, deps } = await createRouteTestApp(FASTIFY_SHUTDOWN_OPTIONS);
    const { server, payload, outgoing, wrongAuthorization } = await gatewayFixture(app, deps);
    const activeTurns = new ActiveTurnsRegistry();
    activeTurns.mark("draining-session", { tenantId: "admin-tenant", userId: "admin-user" });
    const sessionId = await prepareMessageRoute(deps, activeTurns);
    await registerAppRoutes(app, deps, { dataRoutes: devDataRoutes() });
    registerAppLifecycle({
      app,
      config: app.config,
      limits: { sweepExpired: () => {} } as AppDependencies["limits"],
      policyService: { close: async () => {} } as AppDependencies["policyService"],
      runtimeAdapter: { close: async () => {} } as unknown as AppDependencies["runtimeAdapter"],
      activeTurns,
      // The running turn keeps the drain open until the test ends it.
      shutdownStageMs: { turnWait: 10_000 },
      schedulerWorker: null
    });
    const post = httpClient(await app.listen({ host: "127.0.0.1", port: 0 }));

    const closed = app.close();
    try {
      await vi.waitFor(() => expect(activeTurns.isDraining()).toBe(true));

      // A real loopback request, as the runtime of a draining turn sends it.
      const gateway = await post(server.routePath, payload, { authorization: outgoing[1]! });
      expect(gateway.status).toBe(200);
      expect((await gateway.json()).result.protocolVersion).toBeTruthy();
      const denied = await post(server.routePath, payload, { authorization: wrongAuthorization });
      expect(denied.status).toBe(401);
      await denied.text();

      const message = await post("/messages", { sessionId, text: "hello" });
      expect(message.status).toBe(503);
      expect(await message.json()).toMatchObject({ error: "server_draining" });
    } finally {
      activeTurns.clear("draining-session");
      await closed;
    }
  });

  test("with local login and email, the drain starts before the wait for password resets, and the resets end before the pools close", async () => {
    const events: string[] = [];
    const { app, deps } = await createRouteTestApp(FASTIFY_SHUTDOWN_OPTIONS);
    vi.spyOn(app.db, "end").mockImplementation(async () => { events.push("database"); });
    const { server, payload, outgoing } = await gatewayFixture(app, deps);
    const activeTurns = new ActiveTurnsRegistry();
    const sessionId = await prepareMessageRoute(deps, activeTurns);
    let finishReset!: () => void;
    const requestPasswordReset = vi.fn(() => new Promise<string>((resolve) => {
      finishReset = () => {
        events.push("reset");
        resolve("sent");
      };
    }));
    const mailConfig = createTestConfig({
      AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["local"], SMTP_URL: "smtps://smtp.example.test", MAIL_FROM: "no-reply@example.test"
    });
    // The order of app.ts: auth routes, app routes, then the lifecycle.
    const { passwordResets } = await registerLocalAuthRoutes(app, {
      db: app.db,
      config: mailConfig,
      auditEvents: deps.auditEvents,
      localAuth: { accounts: { requestPasswordReset } } as unknown as LocalAuth
    });
    await registerAppRoutes(app, deps, { dataRoutes: devDataRoutes() });
    const resetWait = vi.spyOn(passwordResets!, "drain");
    registerAppLifecycle({
      app,
      config: app.config,
      limits: { sweepExpired: () => {} } as AppDependencies["limits"],
      policyService: { close: async () => {} } as AppDependencies["policyService"],
      runtimeAdapter: { close: async () => {} } as unknown as AppDependencies["runtimeAdapter"],
      activeTurns,
      passwordResets,
      schedulerWorker: null
    });
    const request = httpClient(await app.listen({ host: "127.0.0.1", port: 0 }));
    const forgot = (email: string) => request("/auth/local/password/forgot", { email }, { origin: mailConfig.API_ORIGIN });

    expect((await forgot("a@example.com")).status).toBe(202);
    await vi.waitFor(() => expect(requestPasswordReset).toHaveBeenCalledTimes(1));

    const closed = app.close();
    try {
      // The shutdown waits for the pending reset, with the production limit.
      await vi.waitFor(() => expect(resetWait).toHaveBeenCalledWith(SHUTDOWN_STAGE_MS.passwordResets));
      expect(activeTurns.isDraining()).toBe(true);

      const message = await request("/messages", { sessionId, text: "hello" });
      expect(message.status).toBe(503);
      expect(await message.json()).toMatchObject({ error: "server_draining" });
      const ready = await request("/ready");
      expect(ready.status).toBe(503);
      await ready.text();
      const gateway = await request(server.routePath, payload, { authorization: outgoing[1]! });
      expect(gateway.status).toBe(200);
      expect((await gateway.json()).result.protocolVersion).toBeTruthy();
      // The same answer, but the shutdown started no new work.
      expect((await forgot("b@example.com")).status).toBe(202);
      expect(requestPasswordReset).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);
    } finally {
      finishReset();
      await closed;
    }
    expect(events).toEqual(["reset", "database"]);
  });

  test("app.close ends a viewer stream of a turn on another replica, disconnects its reader, and runs the cleanup", async () => {
    const events: string[] = [];
    const app = Fastify(FASTIFY_SHUTDOWN_OPTIONS);
    app.decorate("config", createTestConfig());
    app.decorate("db", { end: async () => { events.push("database"); } } as unknown as Pool);
    app.addHook("onRequest", async (request) => {
      request.auth = { userId: "user-1", tenantId: "tenant-1", isAdmin: false, role: "member" };
    });
    // A reader blocked in XREAD until it disconnects, as with ioredis: the
    // turn runs on another replica and sends no event.
    const readers: Array<{ disconnects: number; fail?: (error: Error) => void }> = [];
    const turnBus = {
      replay: vi.fn(async () => []),
      reader: () => {
        const reader = {
          disconnects: 0,
          fail: undefined as ((error: Error) => void) | undefined,
          disconnect() {
            reader.disconnects += 1;
            reader.fail?.(new Error("Connection is closed."));
          }
        };
        readers.push(reader);
        return reader;
      },
      waitForEvents: vi.fn((reader: (typeof readers)[number]) =>
        new Promise<never>((_resolve, reject) => { reader.fail = reject; })),
      publishStop: vi.fn()
    };
    const executions = {
      currentOwner: vi.fn(async () => ({ executionId: "execution-remote" })),
      stop: vi.fn(),
      stopAndGetOwner: vi.fn()
    };
    const sessionId = randomUUID();
    await registerSessionRoutes(app, {
      sessions: {
        getReadable: async () => ({ sessionId, userId: "user-1", status: "active", transcriptFormat: "current" })
      },
      messages: { listBySession: async () => ({ messages: [], hasMore: false }) },
      activeTurns: new ActiveTurnsRegistry(),
      executions,
      turnBus
    } as never);
    registerAppLifecycle({
      app,
      config: app.config,
      limits: { sweepExpired: () => {} } as AppDependencies["limits"],
      policyService: { close: async () => { events.push("policy"); } } as AppDependencies["policyService"],
      runtimeAdapter: { close: async () => { events.push("runtime"); } } as unknown as AppDependencies["runtimeAdapter"],
      schedulerWorker: null
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const stream = await openStream(`${address}/sessions/${sessionId}/connect`);
    try {
      await vi.waitFor(() => expect(turnBus.waitForEvents).toHaveBeenCalled());
      expect(app.sseConnections.size).toBe(1);

      const started = Date.now();
      await app.close();

      // Without the stream registry, server.close() waits for this stream
      // as long as the remote turn runs, and onClose never runs.
      expect(Date.now() - started).toBeLessThan(2_000);
      await stream.ended;
      expect(stream.body()).toContain("RUN_FINISHED");
      expect(readers).toHaveLength(1);
      expect(readers[0]!.disconnects).toBeGreaterThan(0);
      expect(events).toEqual(["runtime", "policy", "database"]);
      expect(app.sseConnections.size).toBe(0);
      // Only the viewer closed: the turn on the other replica is not stopped.
      expect(executions.stop).not.toHaveBeenCalled();
      expect(executions.stopAndGetOwner).not.toHaveBeenCalled();
      expect(turnBus.publishStop).not.toHaveBeenCalled();
    } finally {
      stream.response.destroy();
      await app.close();
    }
  });
});
