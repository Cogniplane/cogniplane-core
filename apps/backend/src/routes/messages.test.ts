import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test } from "vitest";

import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { ActiveTurnMessageMap } from "../services/active-turn-message-map.js";
import { registerMessageRoutes, type MessageRouteStores } from "./messages.js";

const SESSION_ID = "37af657a-2fed-4148-a5fa-ec6b34ccc959";

// ---------------------------------------------------------------------------
// Minimal app wiring
//
// The TOCTOU finding is about the window between the `hasActiveTurn` busy check
// and the point where the runtime adapter actually flips a session to busy
// (deep inside `runMessage`, far past several `await`s that persist the user
// message and consume rate-limit/quota). We exercise the route directly with a
// real `ActiveTurnsRegistry` (the single-process reservation registry that
// production wires in) and assert the reservation is atomic: a request that
// loses the race is rejected with 429 BEFORE it persists a user message or
// consumes quota.
// ---------------------------------------------------------------------------

function makeStores(options: { gateRuntime?: () => Promise<void> } = {}) {
  const createdMessages: Array<{ role: string; content: string }> = [];
  const consumedRateLimit: string[] = [];
  const consumedQuota: string[] = [];
  const activeTurns = new ActiveTurnsRegistry();

  let releaseRuntime: (() => void) | null = null;
  const runtimeGate = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });

  const runtimeManager = {
    id: "codex",
    // Never reports busy on its own — the registry reservation must be what
    // stops the second concurrent request.
    hasActiveTurn: () => false,
    async createSession() {
      return {
        sessionId: "session-1",
        runtimeId: "runtime-1",
        runtimePolicy: {
          id: "default",
          label: "Default",
          description: null,
          runtimeProvider: "codex" as const,
          approvalPolicy: "never" as const,
          approvalReviewer: "user" as const,
          sandboxMode: "workspace-write" as const,
          networkMode: "restricted" as const,
          allowCommandExecution: false,
          allowUserTokenForwarding: false,
          autoApproveReadOnlyTools: false,
          developerInstructions: null,
          enabledToolIds: [],
          enabledMcpServers: [],
          version: 1,
          hash: "h"
        }
      };
    },
    async *runMessage() {
      // Hold the turn open so two requests overlap on the same session.
      await (options.gateRuntime ? options.gateRuntime() : runtimeGate);
      yield { type: "response.created", responseId: "r1" } as const;
      yield { type: "response.completed", responseId: "r1" } as const;
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
        return null;
      },
      async consumeTurnQuota(input: { userId: string }) {
        consumedQuota.push(input.userId);
        return null;
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
    runtimeManager,
    activeTurns,
    activeTurnMessageMap: new ActiveTurnMessageMap()
  } as unknown as MessageRouteStores;

  return {
    stores,
    activeTurns,
    runtimeManager,
    createdMessages,
    consumedRateLimit,
    consumedQuota,
    releaseRuntime: () => releaseRuntime?.()
  };
}

async function buildApp(stores: MessageRouteStores): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("config", {
    API_ORIGIN: "http://localhost:3000",
    CODEX_MODEL: "gpt-5.4"
  } as never);
  app.addHook("preHandler", async (request) => {
    (request as unknown as { auth: { userId: string; tenantId: string } }).auth = {
      userId: "platform-user",
      tenantId: "test-tenant"
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

test("a concurrent second turn on the same session is rejected before persisting or consuming quota (TOCTOU)", async () => {
  const harness = makeStores();
  const app = await buildApp(harness.stores);
  activeApp = app;

  // First request: opens an SSE stream and parks inside runMessage (gated).
  const first = app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "first" }
  });

  // Wait until the registry shows the slot reserved by the first request.
  for (let i = 0; i < 100 && !harness.activeTurns.snapshot().has(SESSION_ID); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(harness.activeTurns.snapshot().has(SESSION_ID)).toBe(true);

  const createdBefore = harness.createdMessages.length;
  const quotaBefore = harness.consumedQuota.length;

  // Second request lands while the first turn is still in flight.
  const second = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { sessionId: SESSION_ID, text: "second" }
  });

  expect(second.statusCode).toBe(429);
  expect(second.json()).toEqual({ error: "session_busy" });
  // The loser must not have persisted a user message or burned quota.
  expect(harness.createdMessages.length).toBe(createdBefore);
  expect(harness.consumedQuota.length).toBe(quotaBefore);

  // Let the first turn finish.
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

  // The stream writer's `finally` must have cleared the registry slot.
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
