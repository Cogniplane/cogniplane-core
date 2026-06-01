import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test } from "vitest";

import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { ActiveTurnMessageMap } from "../services/active-turn-message-map.js";
import { registerMessageRoutes, type MessageRouteStores } from "./messages.js";

const SESSION_ID = "37af657a-2fed-4148-a5fa-ec6b34ccc959";

// The TOCTOU risk sits between the route's busy check and the runtime adapter
// marking the session busy. Exercise the route with a real ActiveTurnsRegistry
// and assert the losing request is rejected before it persists or consumes quota.
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
          webSearchMode: "disabled" as const,
          approvalPolicy: "never" as const,
          approvalReviewer: "user" as const,
          sandboxMode: "workspace-write" as const,
          networkMode: "restricted" as const,
          allowCommandExecution: false,
          allowUserTokenForwarding: false,
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
    async *runMessage() {
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
    createdMessages,
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
