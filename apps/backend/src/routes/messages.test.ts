import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test } from "vitest";
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
    sessions: {
      async getOwned() {
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
