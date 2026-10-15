import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";

import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { generateSessionTitle } from "../services/session-titler.js";
import { registerMessageRoutes, type MessageRouteStores } from "./messages.js";

vi.mock("../services/session-titler.js", () => ({ generateSessionTitle: vi.fn(async () => null) }));

const SESSION_ID = "37af657a-2fed-4148-a5fa-ec6b34ccc959";

/** A session that the message route can continue. */
function readableSession(fields: { sessionId: string; sessionName: string; projectId?: string }) {
  return { status: "active" as const, transcriptFormat: "current" as const, ...fields };
}

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
    finishTurnAdmission: vi.fn(async () => {}),
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
          sandboxEgressDomains: [],
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
      acquire: vi.fn(async (actor: { tenantId: string; sessionId: string; userId: string }) => ({ ...actor, executionId: "execution-test", ownerId: "replica-test", projectId: null, expiresAt: new Date(Date.now() + 30_000).toISOString() })),
      heartbeat: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    },
    sessions: {
      async getReadable() {
        return readableSession({ sessionId: "session-1", sessionName: "Existing session" });
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
      async updateContent(_tenantId: string, messageId: string, _userId: string, status: string, content: string) {
        return { messageId, status, content };
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
    finishTurnAdmission: runtimeManager.finishTurnAdmission,
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
    MAX_RUNNING_TURNS_PER_USER: 5,
    MAX_RUNNING_TURNS_PER_TENANT: 50,
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

test.each([
  { limit: "user", owner: "platform-user", config: { MAX_RUNNING_TURNS_PER_USER: 1 } },
  { limit: "tenant", owner: "another-user", config: { MAX_RUNNING_TURNS_PER_TENANT: 1 } }
])("rejects the $limit running-turn cap before side effects", async ({ owner, config }) => {
  const harness = makeStores();
  harness.activeTurns.mark("another-session", { tenantId: "test-tenant", userId: owner });
  const app = await buildApp(harness.stores, config);
  activeApp = app;

  const response = await app.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "next" } });

  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual({ error: "running_turn_limit" });
  expect(harness.createdMessages).toEqual([]);
  expect(harness.consumedQuota).toEqual([]);
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
  expect(harness.finishTurnAdmission).toHaveBeenCalledWith({
    tenantId: expect.any(String), sessionId: SESSION_ID, userId: expect.any(String)
  });
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

test.each([
  ["legacy", "legacy"],
  ["unsupported", "unsupported"],
  ["absent", undefined]
] as const)("refuses a session with a %s history format before any turn work", async (_, transcriptFormat) => {
  const harness = makeStores({ gateRuntime: async () => undefined });
  const getReadable = vi.fn().mockResolvedValue({
    sessionId: SESSION_ID, sessionName: "Old chat", status: "active", ...(transcriptFormat ? { transcriptFormat } : {})
  });
  harness.stores.sessions.getReadable = getReadable;
  const evaluateText = vi.fn();
  harness.stores.piiProtection = { evaluateText };
  const getTenantSettings = vi.spyOn(harness.stores.dynamicConfig, "getOrCreateTenantSettings");
  const run = vi.spyOn(harness.stores.runtimeAdapter, "runMessageAGUI");
  activeApp = await buildApp(harness.stores);

  const response = await activeApp.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "Continue" } });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({
    error: "unsupported_transcript_format",
    message: "This version of Cogniplane cannot continue a chat in this history format. Start a new chat."
  });
  // Nothing past the session read ran: no model resolution, slot, lease, rate
  // limit, PII scan, saved prompt, or runtime (which loads the checkpoint).
  expect(getReadable).toHaveBeenCalledOnce();
  expect(getTenantSettings).not.toHaveBeenCalled();
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(false);
  expect(harness.stores.executions.acquire).not.toHaveBeenCalled();
  expect(harness.consumedQuota).toEqual([]);
  expect(evaluateText).not.toHaveBeenCalled();
  expect(harness.createdMessages).toEqual([]);
  expect(run).not.toHaveBeenCalled();
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
  h.stores.sessions.getReadable = vi.fn().mockResolvedValue(readableSession({ sessionId: SESSION_ID, sessionName: "Proposal", projectId: "project-1" }));
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
  h.stores.sessions.getReadable = vi.fn().mockResolvedValue(
    readableSession({ sessionId: SESSION_ID, sessionName: "Proposal", projectId: "project-1" }));
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
  h.stores.sessions.getReadable = vi.fn().mockResolvedValue(readableSession({ sessionId: SESSION_ID, sessionName: "Proposal", projectId: "project-1" }));
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
  h.stores.sessions.getReadable = vi.fn().mockResolvedValue(readableSession({ sessionId: SESSION_ID, sessionName: "Proposal", projectId: "project-1" }));
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

test("a tenant with a spending limit keeps the local titler but not the paid fallback", async () => {
  const h = makeStores({ gateRuntime: async () => {} });
  vi.spyOn(h.stores.sessions, "getReadable").mockResolvedValue(
    readableSession({ sessionId: "session-1", sessionName: "New session" }) as never);
  const hasLimit = vi.fn(async () => true);
  const tenantKey = vi.fn(async () => "sk-tenant");
  Object.assign(h.stores, { modelSpending: { hasLimit }, getTenantAnthropicApiKey: tenantKey });
  activeApp = await buildApp(h.stores, { ANTHROPIC_API_KEY: "sk-operator", UTILITY_LLM_ENABLED: true,
    UTILITY_LLM_BASE_URL: "http://utility.local", UTILITY_LLM_MODEL: "local-model" });

  await activeApp.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "Hello" } });

  await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledTimes(1));
  expect(hasLimit).toHaveBeenCalledWith("test-tenant");
  expect(tenantKey).not.toHaveBeenCalled();
  expect(vi.mocked(generateSessionTitle).mock.calls[0]![0]).toMatchObject({
    keys: { anthropicApiKey: null }, utilityClient: expect.anything() });
});

// ─── Session titling (fire-and-forget after the first turn) ───────────────

const titled = {
  title: "Quarterly plan",
  modelName: "claude-haiku-4-5",
  tokenUsage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 8, reasoningOutputTokens: 0, totalTokens: 128 }
};

/** Let pending microtasks run, so code that would follow an awaited call has had its chance. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

async function postFirstTurn(options: {
  limited?: boolean;
  tenantKey?: string | null;
  renamed?: boolean;
  utilityTitler?: boolean;
} = {}) {
  vi.mocked(generateSessionTitle).mockClear();
  const h = makeStores({ gateRuntime: async () => {} });
  vi.spyOn(h.stores.sessions, "getReadable").mockResolvedValue(
    readableSession({ sessionId: "session-1", sessionName: "New session" }) as never);
  const create = vi.spyOn(h.stores.messages, "create");
  const renameIfCurrent = vi.fn(async (_tenantId: string, _sessionId: string, _userId: string, _current: string, _title: string) =>
    options.renamed ?? true);
  const addTokenUsage = vi.fn(async (_tenantId: string, _messageId: string, _userId: string, _usage: unknown, _model: string) => undefined);
  const setCostUsd = vi.fn(async (_tenantId: string, _messageId: string, _userId: string, _cost: number | null) => undefined);
  const hasLimit = vi.fn(async () => options.limited ?? false);
  const getTenantAnthropicApiKey = vi.fn(async () => options.tenantKey ?? null);
  Object.assign(h.stores.sessions, { renameIfCurrent });
  Object.assign(h.stores.messages, { addTokenUsage, setCostUsd });
  Object.assign(h.stores, { modelSpending: { hasLimit }, getTenantAnthropicApiKey });
  activeApp = await buildApp(h.stores, {
    ANTHROPIC_API_KEY: "sk-operator",
    SESSION_TITLER_CLAUDE_MODEL: "claude-haiku-4-5",
    SESSION_TITLER_TIMEOUT_MS: 5_000,
    ...(options.utilityTitler
      ? { UTILITY_LLM_ENABLED: true, UTILITY_LLM_BASE_URL: "http://utility.local", UTILITY_LLM_MODEL: "local-model" }
      : {})
  });

  await activeApp.inject({ method: "POST", url: "/messages", payload: { sessionId: SESSION_ID, text: "Plan Q4" } });
  const titlingMessages = () => create.mock.calls.filter(([input]) => (input as { role: string }).role === "system");
  return { create, titlingMessages, renameIfCurrent, addTokenUsage, setCostUsd, hasLimit, getTenantAnthropicApiKey };
}

test("titling records the title as a system message with its token usage and cost", async () => {
  vi.mocked(generateSessionTitle).mockResolvedValueOnce(titled);
  const t = await postFirstTurn();

  await vi.waitFor(() => expect(t.setCostUsd).toHaveBeenCalled());
  expect(t.renameIfCurrent).toHaveBeenCalledWith("test-tenant", SESSION_ID, "platform-user", "New session", "Quarterly plan");
  expect(t.titlingMessages()).toHaveLength(1);
  expect(t.titlingMessages()[0]![0]).toMatchObject({
    role: "system", status: "completed", content: "Quarterly plan", detail: { kind: "session_titling" }
  });
  const titlingId = (await t.create.mock.results.at(-1)!.value as { messageId: string }).messageId;
  expect(t.addTokenUsage).toHaveBeenCalledWith("test-tenant", titlingId, "platform-user", titled.tokenUsage, "claude-haiku-4-5");
  const [, costMessageId, , cost] = t.setCostUsd.mock.calls[0]!;
  expect(costMessageId).toBe(titlingId);
  expect(cost).toBeGreaterThan(0);
});

test("titling prefers the tenant's own Anthropic key, trimmed, over the operator key", async () => {
  const withTenantKey = await postFirstTurn({ tenantKey: "  sk-tenant  " });
  await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledTimes(1));
  expect(vi.mocked(generateSessionTitle).mock.calls[0]![0]).toMatchObject({ keys: { anthropicApiKey: "sk-tenant" } });
  expect(withTenantKey.getTenantAnthropicApiKey).toHaveBeenCalledWith("test-tenant");
  await activeApp!.close();
  activeApp = null;

  await postFirstTurn({ tenantKey: null });
  await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledTimes(1));
  expect(vi.mocked(generateSessionTitle).mock.calls[0]![0]).toMatchObject({ keys: { anthropicApiKey: "sk-operator" } });
});

test("titling is skipped for a tenant over its spending limit when no local titler exists", async () => {
  const t = await postFirstTurn({ limited: true });

  await vi.waitFor(() => expect(t.hasLimit).toHaveBeenCalledWith("test-tenant"));
  await drain();
  expect(generateSessionTitle).not.toHaveBeenCalled();
  expect(t.getTenantAnthropicApiKey).not.toHaveBeenCalled();
});

test("titling records nothing when another turn already renamed the session", async () => {
  vi.mocked(generateSessionTitle).mockResolvedValueOnce(titled);
  const t = await postFirstTurn({ renamed: false });

  await vi.waitFor(() => expect(t.renameIfCurrent).toHaveBeenCalled());
  await drain();
  expect(t.titlingMessages()).toHaveLength(0);
  expect(t.addTokenUsage).not.toHaveBeenCalled();
  expect(t.setCostUsd).not.toHaveBeenCalled();
});

test("a failed titler call is contained and leaves no unhandled rejection", async () => {
  vi.mocked(generateSessionTitle).mockRejectedValueOnce(new Error("titler down"));
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const t = await postFirstTurn();
    await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledTimes(1));
    await drain();
    await drain();
    expect(t.renameIfCurrent).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
  expect(unhandled).not.toHaveBeenCalled();
});
