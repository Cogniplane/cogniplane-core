import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";

import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { registerMessageRoutes, type MessageRouteStores } from "./messages.js";

const SESSION_ID = "37af657a-2fed-4148-a5fa-ec6b34ccc959";

// The TOCTOU risk sits between the route's busy check and the runtime adapter
// marking the session busy. Exercise the route with a real ActiveTurnsRegistry
// and assert the losing request is rejected before it persists or consumes quota.
function makeStores(
  options: {
    gateRuntime?: () => Promise<void>;
    rateLimitError?: { retryAfterMs: number } | null;
    quotaError?: { retryAfterMs: number } | null;
    hasProviderKey?: (tenantId: string, provider: string) => Promise<boolean>;
  } = {}
) {
  const createdMessages: Array<{ role: string; content: string }> = [];
  const consumedRateLimit: string[] = [];
  const consumedQuota: string[] = [];
  const activeTurns = new ActiveTurnsRegistry();

  let releaseRuntime: (() => void) | null = null;
  const runtimeGate = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });

  const runtimeManager = {
    id: "deep-agents",
    hasActiveTurn: () => false,
    async createSession() {
      return {
        sessionId: "session-1",
        runtimeId: "runtime-1",
        runtimePolicy: {
          id: "default",
          label: "Default",
          description: null,
          webSearchMode: "disabled" as const,
          approvalPolicy: "never" as const,
          approvalReviewer: "user" as const,
          sandboxMode: "workspace-write" as const,
          networkMode: "restricted" as const,
          allowCommandExecution: false,
          autoApproveReadOnlyTools: false,
          policyEnforcementMode: "monitor" as const,
          developerInstructions: null,
          enabledToolIds: [],
          enabledMcpServers: [],
          version: 1,
          hash: "h"
        }
      };
    },
    // Emit a minimal valid AG-UI run carrying one assistant text message.
    async *runMessageAGUI(): AsyncGenerator<BaseEvent> {
      await (options.gateRuntime ? options.gateRuntime() : runtimeGate);
      const runId = "run-agui-1";
      const messageId = "msg-agui-1";
      yield { type: EventType.RUN_STARTED, threadId: SESSION_ID, runId } as BaseEvent;
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent;
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "hello from agui" } as BaseEvent;
      yield { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent;
      yield { type: EventType.RUN_FINISHED, threadId: SESSION_ID, runId } as BaseEvent;
    }
  };

  const stores = {
    executions: {
      acquire: vi.fn(async (actor: { tenantId: string; sessionId: string; userId: string }) => ({ ...actor, executionId: "execution-test", projectId: "project-1", expiresAt: new Date(Date.now() + 30_000).toISOString() })),
      heartbeat: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    },
    sessions: {
      async getReadable() {
        return { sessionId: "session-1", sessionName: "Existing session", status: "active" };
      }
    },
    artifacts: {
      async listBySession() {
        return [];
      }
    },
    artifactProcessor: undefined,
    storage: undefined,
    limits: {
      async consumeRateLimit(input: { userId: string }) {
        consumedRateLimit.push(input.userId);
        return options.rateLimitError ?? null;
      },
      async consumeTurnQuota(input: { userId: string }) {
        consumedQuota.push(input.userId);
        return options.quotaError ?? null;
      }
    },
    messages: {
      async create(input: { role: string; content: string }) {
        createdMessages.push({ role: input.role, content: input.content });
        return {
          messageId: `msg-${createdMessages.length}`,
          sessionId: "session-1",
          userId: "platform-user",
          role: input.role,
          status: "completed",
          content: input.content
        };
      },
      async updateContent() {
        return null;
      },
      async updateStreamingContent() {
        return null;
      }
    },
    toolContexts: {
      async create() {
        return { toolContextId: "ctx-1" };
      }
    },
    runtimeAdapter: runtimeManager,
    activeTurns,
    // Model availability defaults: everything enabled, no effort overrides.
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledProviders: ["anthropic", "openai", "google", "openrouter", "zai"],
          enabledModelIds: null,
          modelDefaultEfforts: {}
        };
      }
    },
    // Only wired when a test opts in — otherwise the resolver skips provider
    // gating and every request resolves the happy default.
    ...(options.hasProviderKey ? { hasProviderKey: options.hasProviderKey } : {})
  } as unknown as MessageRouteStores;

  return {
    stores,
    activeTurns,
    createdMessages,
    consumedQuota,
    releaseRuntime: () => releaseRuntime?.()
  };
}

async function buildApp(
  stores: MessageRouteStores,
  configOverrides: Record<string, unknown> = {}
): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("config", {
    API_ORIGIN: "http://localhost:3000",
    SESSION_EXECUTION_LEASE_MS: 30_000,
    SESSION_EXECUTION_HEARTBEAT_MS: 5_000,
    ...configOverrides
  } as never);
  app.addHook("preHandler", async (request) => {
    (request as unknown as { auth: { userId: string; tenantId: string; role: "owner" } }).auth = {
      userId: "platform-user",
      tenantId: "test-tenant",
      role: "owner"
    };
  });
  await registerMessageRoutes(app, stores);
  await app.ready();
  return app;
}

let activeApp: FastifyInstance | null = null;
afterEach(async () => {
  if (activeApp) {
    await activeApp.close();
    activeApp = null;
  }
});

test("a concurrent second turn on the same session is rejected before persisting or consuming quota", async () => {
  const harness = makeStores();
  const app = await buildApp(harness.stores);
  activeApp = app;

  const first = app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "first" }
  });

  for (let i = 0; i < 100 && !harness.activeTurns.snapshot().has(SESSION_ID); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(true);

  const createdBefore = harness.createdMessages.length;
  const quotaBefore = harness.consumedQuota.length;

  const second = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "second" }
  });

  expect(second.statusCode).toBe(429);
  expect(second.json()).toEqual({ error: "session_busy" });
  expect(harness.createdMessages.length).toBe(createdBefore);
  expect(harness.consumedQuota.length).toBe(quotaBefore);

  harness.releaseRuntime();
  await first;
});

test("the reserved slot is released after the first turn completes, allowing a follow-up turn", async () => {
  const harness = makeStores();
  const app = await buildApp(harness.stores);
  activeApp = app;

  const first = app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "first" }
  });
  harness.releaseRuntime();
  await first;

  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);

  const second = app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "second" }
  });
  harness.releaseRuntime();
  const secondResult = await second;
  expect(secondResult.statusCode).toBe(200);
});

test("releases the reserved slot when the turn quota is exhausted (early-return path)", async () => {
  // The slot is reserved before the quota check. A 429 early-return must free it
  // via the route's finally — otherwise the session stays wedged busy forever
  // and the user can never send another turn.
  const harness = makeStores({ quotaError: { retryAfterMs: 5_000 } });
  const app = await buildApp(harness.stores);
  activeApp = app;

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "over quota" }
  });

  expect(response.statusCode).toBe(429);
  // The slot the route reserved is released, so the session is free again.
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);
});

test("releases the reserved slot when the rate limit is exhausted (early-return path)", async () => {
  const harness = makeStores({ rateLimitError: { retryAfterMs: 3_000 } });
  const app = await buildApp(harness.stores);
  activeApp = app;

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "too fast" }
  });

  expect(response.statusCode).toBe(429);
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);
});

test("returns the resolver's provider-key error without reserving a slot or persisting", async () => {
  // Model resolution runs BEFORE slot reservation/persistence. When the selected
  // provider has no key, the resolver returns a 400 and the route returns it
  // directly — no slot reserved, no user message written.
  const harness = makeStores({ hasProviderKey: async () => false });
  const app = await buildApp(harness.stores);
  activeApp = app;

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "hi" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("provider_api_key_required");
  // No side effects: nothing reserved, nothing persisted.
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);
  expect(harness.createdMessages.length).toBe(0);
});

test("hijacked SSE responses set security and no-store cache headers directly", async () => {
  const harness = makeStores({ gateRuntime: async () => undefined });
  const app = await buildApp(harness.stores);
  activeApp = app;

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "stream" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["cache-control"]).toBe("no-store, no-cache, no-transform");
});

test("POST /messages dispatches AG-UI, persists the user turn, and releases the slot", async () => {
  const harness = makeStores({ gateRuntime: async () => undefined });
  const app = await buildApp(harness.stores, { TOOL_CONTEXT_TTL_MS: 60_000 });
  activeApp = app;

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "hi over agui" }
  });

  expect(response.statusCode).toBe(200);
  // The client's HttpAgent parses these data frames directly.
  const frames = response.body
    .split("\n\n")
    .map((line) => line.replace(/^data: /, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BaseEvent);
  const eventTypes = frames.map((frame) => frame.type);

  expect(eventTypes).toContain(EventType.RUN_STARTED);
  expect(eventTypes).toContain(EventType.RUN_FINISHED);
  // The assistant text reaches the client as a TEXT_MESSAGE_CONTENT delta.
  const contentFrame = frames.find(
    (frame) => frame.type === EventType.TEXT_MESSAGE_CONTENT
  ) as { delta?: string } | undefined;
  expect(contentFrame?.delta).toBe("hello from agui");

  // The user's turn was persisted (dispatch ran, not a short-circuit).
  expect(harness.createdMessages).toContainEqual({ role: "user", content: "hi over agui" });

  // The route releases the reserved slot after the turn.
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);
});


test("a stale runtime failure releases the route reservation and allows the next turn", async () => {
  let rejectTurn = true;
  const failureMessage = "Runtime session is no longer current. Start a new turn.";
  const harness = makeStores({ gateRuntime: async () => {
    expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(true);
    if (rejectTurn) throw Object.assign(new Error(failureMessage), { statusCode: 409 });
  } });
  const persist = vi.spyOn(harness.stores.messages, "updateContent");
  const app = await buildApp(harness.stores);
  activeApp = app;
  const request = { method: "POST" as const, url: "/messages",
    payload: { sessionId: SESSION_ID, text: "hello" } };
  const response = await app.inject(request);
  expect(response.statusCode).toBe(200);
  const frames = response.body.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as BaseEvent);
  expect(frames.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: failureMessage });
  expect(persist).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String),
    "error", failureMessage, expect.any(Number));
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);

  rejectTurn = false;
  const next = await app.inject(request);
  expect(next.statusCode).toBe(200);
  expect(next.body).toContain('"type":"RUN_FINISHED"');
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);
});

test("rejects a session archived between model resolution and turn reservation", async () => {
  const harness = makeStores();
  const getReadable = vi.spyOn(harness.stores.sessions, "getReadable");
  const original = await harness.stores.sessions.getReadable("tenant", SESSION_ID, "user");
  getReadable.mockClear();
  getReadable.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original!, status: "archived" });
  const app = await buildApp(harness.stores);
  activeApp = app;
  const response = await app.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "too late" } });
  expect(response.statusCode).toBe(404);
  expect(harness.createdMessages).toEqual([]);
  expect(harness.consumedQuota).toEqual([]);
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);
});

test("capability mutations block new turns without reporting streaming activity", async () => {
  const harness = makeStores();
  const app = await buildApp(harness.stores);
  activeApp = app;
  const release = harness.activeTurns.reserveMutation(SESSION_ID)!;
  try {
    const response = await app.inject({ method: "POST", url: "/messages",
      payload: { sessionId: SESSION_ID, text: "during capability save" } });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "session_busy" });
    expect(harness.activeTurns.snapshot().size).toBe(0);
    expect(harness.createdMessages).toHaveLength(0);
    expect(harness.consumedQuota).toHaveLength(0);
  } finally { release(); }
});

test("records the resolved project revision and sends the same snapshot to the runtime", async () => {
  const h = makeStores({ gateRuntime: async () => {} });
  h.stores.sessions.getReadable = vi.fn().mockResolvedValue({ sessionId: SESSION_ID,
    sessionName: "Proposal", status: "active", projectId: "project-1" });
  const snapshot = { projectId: "project-1", instructions: "Write in French", instructionsRevision: 2 };
  h.stores.projects = { getReadable: vi.fn().mockResolvedValue(snapshot) };
  const create = vi.spyOn(h.stores.messages, "create");
  const run = vi.spyOn(h.stores.runtimeAdapter, "runMessageAGUI");
  activeApp = await buildApp(h.stores);
  const response = await activeApp.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "Draft it" } });
  expect(response.statusCode).toBe(200);
  const expected = { projectId: "project-1", instructions: "Write in French", revision: 2 };
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", detail: { projectInstructions: expected } }));
  expect(run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prompt: "Draft it", projectInstructions: expected }));
  expect(h.stores.projects.getReadable).toHaveBeenCalledWith("test-tenant", "platform-user", "project-1");
});

test("captures selected project files even when project tools are disabled in tenant settings", async () => {
  const h = makeStores({ gateRuntime: async () => {} });
  h.stores.dynamicConfig.getOrCreateTenantSettings = vi.fn().mockResolvedValue({
    enabledProviders: ["anthropic", "openai", "google", "openrouter", "zai"],
    enabledModelIds: null,
    modelDefaultEfforts: {},
    enabledToolIds: []
  });
  h.stores.sessions.getReadable = vi.fn().mockResolvedValue({
    sessionId: SESSION_ID,
    sessionName: "Proposal",
    status: "active",
    projectId: "project-1"
  });
  h.stores.projects = {
    getReadable: vi.fn().mockResolvedValue({
      projectId: "project-1",
      instructions: "",
      instructionsRevision: 1
    })
  };
  const captureRuntimeSnapshot = vi.fn().mockResolvedValue({
    projectId: "project-1",
    capturedAt: "2026-09-16T00:00:00.000Z",
    truncated: false,
    files: []
  });
  h.stores.projectFiles = { captureRuntimeSnapshot };
  activeApp = await buildApp(h.stores);

  const response = await activeApp.inject({
    method: "POST",
    url: "/messages",
    payload: {
      sessionId: SESSION_ID,
      text: "Use the selected project file",
      projectFileIds: ["4b6f7a7a-8a0a-4b64-9bd2-1d2f0c2dd4c1"]
    }
  });

  expect(response.statusCode).toBe(200);
  expect(captureRuntimeSnapshot).toHaveBeenCalledWith(
    { tenantId: "test-tenant", userId: "platform-user", projectId: "project-1" },
    ["4b6f7a7a-8a0a-4b64-9bd2-1d2f0c2dd4c1"]
  );
});

test("returns 503 when tenant settings are unavailable during model resolution", async () => {
  const h = makeStores();
  h.stores.dynamicConfig.getOrCreateTenantSettings = vi.fn().mockRejectedValue(new Error("postgres unreachable"));
  activeApp = await buildApp(h.stores);

  const response = await activeApp.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "Retry this later" }
  });

  expect(response.statusCode).toBe(503);
});

test("blocks project instructions before consuming quota or starting the runtime", async () => {
  const h = makeStores({ gateRuntime: async () => {} });
  h.stores.sessions.getReadable = vi.fn().mockResolvedValue({ sessionId: SESSION_ID,
    sessionName: "Proposal", status: "active", projectId: "project-1" });
  h.stores.projects = { getReadable: vi.fn().mockResolvedValue({ projectId: "project-1", instructions: "Sensitive instructions", instructionsRevision: 1 }) };
  h.stores.piiProtection = { evaluateText: vi.fn().mockResolvedValueOnce({ action: "allow" })
    .mockResolvedValueOnce({ action: "block", findings: [], blockReason: "Sensitive" }) };
  const run = vi.spyOn(h.stores.runtimeAdapter, "runMessageAGUI");
  activeApp = await buildApp(h.stores);
  const response = await activeApp.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "Draft it" } });
  expect(response.statusCode).toBe(422);
  expect(response.json().error).toBe("project_instructions_blocked");
  expect(h.consumedQuota).toHaveLength(0);
  expect(run).not.toHaveBeenCalled();
  expect(h.activeTurns.isBusy(SESSION_ID)).toBe(false);
});

test("uses PII-transformed instructions in both the saved snapshot and model input", async () => {
  const h = makeStores({ gateRuntime: async () => {} });
  h.stores.sessions.getReadable = vi.fn().mockResolvedValue({ sessionId: SESSION_ID,
    sessionName: "Proposal", status: "active", projectId: "project-1" });
  h.stores.projects = { getReadable: vi.fn().mockResolvedValue({ projectId: "project-1", instructions: "Private name", instructionsRevision: 1 }) };
  h.stores.piiProtection = { evaluateText: vi.fn().mockResolvedValueOnce({ action: "allow" })
    .mockResolvedValueOnce({ action: "transform", findings: [], transformedText: "[PERSON]" }) };
  const scan = vi.fn().mockResolvedValue({ scanRunId: "instruction-scan" });
  const audit = vi.fn().mockResolvedValue(undefined);
  h.stores.piiScanRuns = { create: scan };
  h.stores.auditEvents = { create: audit };
  const create = vi.spyOn(h.stores.messages, "create");
  const run = vi.spyOn(h.stores.runtimeAdapter, "runMessageAGUI");
  activeApp = await buildApp(h.stores);
  expect((await activeApp.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "Draft it" } })).statusCode).toBe(200);
  expect(scan).toHaveBeenCalledWith(expect.objectContaining({ subjectType: "project_instructions",
    subjectId: "project-1", instructionsRevision: 1, sourceSessionId: SESSION_ID }));
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: "pii_transformed", payload: expect.objectContaining({
    subjectType: "project_instructions", projectId: "project-1", instructionsRevision: 1
  }) }));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", detail: {
    projectInstructions: { projectId: "project-1", revision: 1, instructions: "[PERSON]" }
  } }));
  expect(run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ projectInstructions: expect.objectContaining({ instructions: "[PERSON]" }) }));
});


test("lost execution releases admission even when runtime abort and streaming are stalled", async () => {
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let finishAbort!: () => void;
  const abortGate = new Promise<void>(resolve => { finishAbort = resolve; });
  const h = makeStores({ gateRuntime: async () => { start(); await gate; } });
  const original = await h.stores.sessions.getReadable("tenant", SESSION_ID, "user");
  vi.spyOn(h.stores.sessions, "getReadable").mockResolvedValue({ ...original!, projectId: "project-1" });
  h.stores.projects = { getReadable: vi.fn().mockResolvedValue({ projectId: "project-1", instructions: "", instructionsRevision: 0 }) };
  const renew = vi.mocked(h.stores.executions.heartbeat).mockResolvedValue(false);
  const abort = vi.fn(() => abortGate);
  h.stores.runtimeAdapter.abortSession = abort;
  activeApp = await buildApp(h.stores);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
  const response = activeApp.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "Hello" } }).then(result => result);
  try {
    await started;
    expect(h.activeTurns.snapshot().has(SESSION_ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ executionId: "execution-test" }));
    expect(h.stores.executions.release).toHaveBeenCalledTimes(1);
    expect(h.activeTurns.snapshot().has(SESSION_ID)).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    finishAbort();
    vi.useRealTimers();
    await response;
  }
  expect(h.stores.executions.release).toHaveBeenCalledTimes(1);
});
