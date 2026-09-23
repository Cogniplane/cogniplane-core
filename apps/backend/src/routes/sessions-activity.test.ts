import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerSessionRoutes, type SessionRouteStores } from "./sessions.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";

vi.mock("../lib/db.js", () => ({ ensureUser: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it("uses the local turn registry for interactive activity, including shared viewers", async () => {
  const app = Fastify();
  const activeTurns = new ActiveTurnsRegistry();
  const session = {
    sessionId: "shared", userId: "other-user", sessionName: "Shared research", status: "active",
    createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z",
    isRunning: true, activeTurnStartedAt: "2026-09-13T12:00:03.456Z",
    latestTurnId: "remote-turn", latestTurnSequence: 42, hasTurnFailed: true
  };
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, {
    sessions: { listPage: vi.fn(async () => ({ sessions: [Object.freeze({ ...session })], nextCursor: null })) },
    activeTurns
  } as unknown as SessionRouteStores);
  try {
    activeTurns.mark("shared", { tenantId: "tenant", userId: "other-user" });
    const response = await app.inject({ method: "GET", url: "/sessions" });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions[0]).toMatchObject({
      isRunning: true,
      latestTurnId: "remote-turn", latestTurnSequence: 42, hasTurnFailed: false
    });
    activeTurns.clear("shared");
    const settled = await app.inject({ method: "GET", url: "/sessions" });
    expect(settled.json().sessions[0]).toMatchObject({ isRunning: false, hasTurnFailed: true });
    expect(settled.json().sessions[0].activeTurnStartedAt).toBeUndefined();
  } finally {
    await app.close();
  }
});

it("keeps database running state for scheduled sessions", async () => {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, {
    sessions: { listPage: vi.fn(async () => ({ sessions: [{
      sessionId: "scheduled", userId: "user", sessionName: "Job", purpose: "scheduled", status: "active",
      createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z", isRunning: true
    }], nextCursor: null })) },
    activeTurns: new ActiveTurnsRegistry()
  } as unknown as SessionRouteStores);
  try {
    const response = await app.inject("/sessions?purposes=scheduled");
    expect(response.json().sessions[0].isRunning).toBe(true);
  } finally { await app.close(); }
});

it("uses the database running state for a turn owned by another replica", async () => {
  const app = Fastify();
  app.addHook("preHandler", async request => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, {
    sessions: { listPage: async () => ({ sessions: [{
      sessionId: "remote", userId: "user", sessionName: "Remote", status: "active",
      purpose: "normal", isRunning: true, activeTurnStartedAt: "2026-09-22T12:00:00Z",
      createdAt: "2026-09-22T11:00:00Z", updatedAt: "2026-09-22T11:00:00Z"
    }], nextCursor: null }) },
    executions: { currentOwner: async () => ({ executionId: "turn", ownerId: "other" }) },
    activeTurns: new ActiveTurnsRegistry()
  } as unknown as SessionRouteStores);
  try {
    const response = await app.inject("/sessions");
    expect(response.json().sessions[0]).toMatchObject({
      isRunning: true, activeTurnStartedAt: "2026-09-22T12:00:00Z"
    });
  } finally { await app.close(); }
});

it("fences a remote turn and publishes Stop to its owner", async () => {
  const app = Fastify();
  const sessionId = "37af657a-2fed-4148-a5fa-ec6b34ccc959";
  const publishStop = vi.fn(async () => {});
  const interruptTurn = vi.fn(async () => "no_active_turn" as const);
  app.addHook("preHandler", async request => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, {
    sessions: { getReadable: async () => ({ sessionId, status: "active", projectId: null, canEdit: true }) },
    executions: { stopAndGetOwner: async () => ({ executionId: "turn", ownerId: "other" }) },
    turnBus: { publishStop },
    activeTurns: new ActiveTurnsRegistry(),
    runtimeAdapter: { interruptTurn }
  } as unknown as SessionRouteStores);
  try {
    const response = await app.inject({ method: "POST", url: `/sessions/${sessionId}/interrupt` });
    expect(response.statusCode).toBe(200);
    expect(publishStop).toHaveBeenCalledWith({ tenantId: "tenant", sessionId,
      userId: "user", executionId: "turn", ownerId: "other" });
    expect(interruptTurn).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it("stops local setup before the execution row exists", async () => {
  const app = Fastify();
  const sessionId = "37af657a-2fed-4148-a5fa-ec6b34ccc959";
  const activeTurns = new ActiveTurnsRegistry();
  activeTurns.mark(sessionId, { tenantId: "tenant", userId: "user" });
  app.addHook("preHandler", async request => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, {
    sessions: { getReadable: async () => ({ sessionId, status: "active", projectId: null, canEdit: true }) },
    executions: { stopAndGetOwner: async () => null },
    activeTurns,
    runtimeAdapter: { interruptTurn: vi.fn(async () => "no_active_turn") },
    auditEvents: { create: vi.fn(async () => ({})) }
  } as unknown as SessionRouteStores);
  try {
    const response = await app.inject({ method: "POST", url: `/sessions/${sessionId}/interrupt` });
    expect(response.statusCode).toBe(200);
    expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(true);
  } finally { await app.close(); }
});

it("stops a turn through the session route without an SSE connection", async () => {
  const app = Fastify();
  const sessionId = "37af657a-2fed-4148-a5fa-ec6b34ccc959";
  const interruptTurn = vi.fn(async () => "interrupted" as const);
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, {
    sessions: { getReadable: vi.fn(async () => ({ sessionId, status: "active", projectId: null })) },
    runtimeAdapter: { id: "deep-agents", interruptTurn },
    auditEvents: { create: vi.fn(async () => ({})) }
  } as unknown as SessionRouteStores);
  try {
    const response = await app.inject({ method: "POST", url: `/sessions/${sessionId}/interrupt` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "interrupted" });
    expect(interruptTurn).toHaveBeenCalledWith({ tenantId: "tenant", sessionId, userId: "user" });
  } finally {
    await app.close();
  }
});

it("accepts Stop while a turn is still in setup", async () => {
  const app = Fastify();
  const sessionId = "37af657a-2fed-4148-a5fa-ec6b34ccc959";
  const activeTurns = new ActiveTurnsRegistry();
  activeTurns.mark(sessionId, { tenantId: "tenant", userId: "user" });
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, {
    sessions: { getReadable: vi.fn(async () => ({ sessionId, status: "active", projectId: null, canEdit: true })) },
    runtimeAdapter: { id: "deep-agents", interruptTurn: vi.fn(async () => "no_active_turn") },
    activeTurns,
    auditEvents: { create: vi.fn(async () => ({})) }
  } as unknown as SessionRouteStores);
  try {
    const response = await app.inject({ method: "POST", url: `/sessions/${sessionId}/interrupt` });
    expect(response.statusCode).toBe(200);
    expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(true);
  } finally { await app.close(); }
});

it("lets a project editor stop setup but does not let a viewer cancel it", async () => {
  const app = Fastify();
  const sessionId = "37af657a-2fed-4148-a5fa-ec6b34ccc959";
  const activeTurns = new ActiveTurnsRegistry();
  activeTurns.mark(sessionId, { tenantId: "tenant", userId: "owner" });
  let canEdit = true;
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "editor", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, {
    sessions: { getReadable: vi.fn(async () => ({ sessionId, status: "active", projectId: "project", canEdit })) },
    executions: { stop: vi.fn(async () => false) },
    runtimeAdapter: { id: "deep-agents", interruptTurn: vi.fn(async () => "no_active_turn") },
    activeTurns,
    auditEvents: { create: vi.fn(async () => ({})) }
  } as unknown as SessionRouteStores);
  try {
    const editorStop = await app.inject({ method: "POST", url: `/sessions/${sessionId}/interrupt` });
    expect(editorStop.statusCode).toBe(200);
    expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(true);
    activeTurns.clear(sessionId);
    activeTurns.mark(sessionId, { tenantId: "tenant", userId: "owner" });
    canEdit = false;
    const viewerStop = await app.inject({ method: "POST", url: `/sessions/${sessionId}/interrupt` });
    expect(viewerStop.statusCode).toBe(409);
    expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(false);
  } finally { await app.close(); }
});

it("decorates listed sessions without mutating store records and clears activity after registry removal", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-13T12:00:03.456Z"));
  const app = Fastify();
  const activeTurns = new ActiveTurnsRegistry();
  const rows = [Object.freeze({
    sessionId: "owned", userId: "user", sessionName: "Research", status: "active",
    createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z"
  })];
  const list = vi.fn(async () => ({ sessions: rows, nextCursor: null }));
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, { sessions: { listPage: list }, activeTurns } as unknown as SessionRouteStores);
  try {
    activeTurns.mark("owned");
    activeTurns.identify("owned", { messageId: "turn-owned", sequence: 42 });
    activeTurns.mark("foreign");
    const response = await app.inject({ method: "GET", url: "/sessions" });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith("tenant", "user", { purposes: undefined, limit: 50 });
    expect(response.json().sessions).toHaveLength(1);
    expect(response.json().sessions[0]).toMatchObject({ isRunning: true, activeTurnStartedAt: "2026-09-13T12:00:03.456Z", latestTurnId: "turn-owned", latestTurnSequence: 42, hasTurnFailed: false });
    activeTurns.clear("owned");
    const settled = await app.inject({ method: "GET", url: "/sessions" });
    expect(settled.json().sessions[0].isRunning).toBe(false);
    expect(settled.json().sessions[0].activeTurnStartedAt).toBeUndefined();
  } finally {
    await app.close();
  }
});

it("validates paging input and passes search and saved-ID filters with the authenticated scope", async () => {
  const app = Fastify();
  const listPage = vi.fn(async () => ({ sessions: [], nextCursor: "next-page" }));
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, { sessions: { listPage } } as unknown as SessionRouteStores);
  try {
    for (const query of ["limit=0", "limit=101", "limit=1.5", "cursor=garbage", "ids=", `ids=${Array(101).fill("id").join(",")}`, "personalOnly=yes", `search=${"x".repeat(201)}`]) {
      expect((await app.inject(`/sessions?${query}`)).statusCode).toBe(400);
    }
    expect(listPage).not.toHaveBeenCalled();
    const cursor = { updatedAt: "2026-09-21T00:00:00.123456Z", sessionId: "older" };
    const params = new URLSearchParams({ cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
      limit: "2", search: "  Research  ", ids: "old,pin", status: "archived", purposes: "normal,skill_improvement", personalOnly: "true" });
    const response = await app.inject(`/sessions?${params}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sessions: [], nextCursor: "next-page" });
    expect(listPage).toHaveBeenCalledWith("tenant", "user", {
      cursor, limit: 2, search: "Research", ids: ["old", "pin"], status: "archived", purposes: ["normal", "skill_improvement"], personalOnly: true
    });
  } finally { await app.close(); }
});
