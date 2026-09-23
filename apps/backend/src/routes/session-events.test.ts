import Fastify from "fastify";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { expect, test, vi } from "vitest";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { registerSessionRoutes, type SessionRouteStores } from "./sessions.js";

const SESSION_ID = "37af657a-2fed-4148-a5fa-ec6b34ccc959";

function makeApp(readable = true) {
  const app = Fastify();
  const activeTurns = new ActiveTurnsRegistry();
  const getReadable = vi.fn(async () => readable
    ? { sessionId: SESSION_ID, status: "active", purpose: "normal", projectId: "project" }
    : null);
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "viewer", tenantId: "tenant", role: "member", isAdmin: false };
  });
  return { app, activeTurns, getReadable };
}

test("the event stream checks session read access before exposing a turn", async () => {
  const { app, activeTurns, getReadable } = makeApp(false);
  activeTurns.mark(SESSION_ID, { tenantId: "tenant", userId: "owner" });
  activeTurns.eventLog(SESSION_ID, "tenant")?.append({ type: EventType.RUN_STARTED, threadId: SESSION_ID, runId: "turn" } as BaseEvent);
  await registerSessionRoutes(app, { sessions: { getReadable }, activeTurns } as unknown as SessionRouteStores);
  try {
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/events` });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("turn");
  } finally { await app.close(); }
});

test("a matching session id in another tenant cannot read this turn", async () => {
  const { app, activeTurns, getReadable } = makeApp();
  activeTurns.mark(SESSION_ID, { tenantId: "other-tenant", userId: "owner" });
  activeTurns.eventLog(SESSION_ID, "other-tenant")?.append({
    type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "private"
  } as BaseEvent);
  await registerSessionRoutes(app, { sessions: { getReadable }, activeTurns } as unknown as SessionRouteStores);
  try {
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/events` });
    expect(response.statusCode).toBe(204);
    expect(response.body).not.toContain("private");
  } finally { await app.close(); }
});

test("the event stream replays, follows, and closes at the end of a turn", async () => {
  const { app, activeTurns, getReadable } = makeApp();
  activeTurns.mark(SESSION_ID, { tenantId: "tenant", userId: "owner" });
  const log = activeTurns.eventLog(SESSION_ID, "tenant")!;
  log.append({ type: EventType.RUN_STARTED, threadId: SESSION_ID, runId: "turn" } as BaseEvent);
  await registerSessionRoutes(app, { sessions: { getReadable }, activeTurns } as unknown as SessionRouteStores);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${address}/sessions/${SESSION_ID}/events?after=0`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("id: 1\ndata:");
    log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent);
    log.append({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hello" } as BaseEvent);
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "m" } as BaseEvent);
    let received = "";
    while (!received.includes("hello")) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      received += new TextDecoder().decode(next.value);
    }
    expect(received).toContain("id: 2\ndata:");
    log.close();
    expect((await reader.read()).done).toBe(true);
  } finally { await app.close(); }
});

test("returns a replay gap when the bounded log no longer has the start", async () => {
  const { app, activeTurns, getReadable } = makeApp();
  activeTurns.mark(SESSION_ID, { tenantId: "tenant", userId: "owner" });
  const log = activeTurns.eventLog(SESSION_ID, "tenant")!;
  log.append({ type: EventType.CUSTOM, name: "big", value: { message: "a".repeat(600_000) } } as BaseEvent);
  log.append({ type: EventType.CUSTOM, name: "big", value: { message: "b".repeat(600_000) } } as BaseEvent);
  await registerSessionRoutes(app, { sessions: { getReadable }, activeTurns } as unknown as SessionRouteStores);
  try {
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/events?after=0` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("replay_gap");
  } finally { await app.close(); }
});

test("a slow subscriber is removed as soon as its pending queue reaches the limit", async () => {
  const { app, activeTurns, getReadable } = makeApp();
  activeTurns.mark(SESSION_ID, { tenantId: "tenant", userId: "owner" });
  const log = activeTurns.eventLog(SESSION_ID, "tenant")!;
  log.append({ type: EventType.RUN_STARTED, threadId: SESSION_ID, runId: "turn" } as BaseEvent);
  await registerSessionRoutes(app, { sessions: { getReadable }, activeTurns } as unknown as SessionRouteStores);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${address}/sessions/${SESSION_ID}/events?after=0`);
    expect(response.status).toBe(200);
    // The first large frame exceeds the socket's write buffer. Keep the
    // reader idle while later events arrive in the same task.
    for (let index = 0; index < 6; index += 1) {
      log.append({ type: EventType.CUSTOM, name: "large", value: { text: "x".repeat(250_000), index } } as BaseEvent);
    }
    expect((log as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
    await response.body?.cancel();
  } finally { await app.close(); }
});

test("a replica without the turn replays and follows events from the shared stream", async () => {
  const { app, activeTurns, getReadable } = makeApp();
  const started = { sequence: 1, event: { type: EventType.RUN_STARTED, threadId: SESSION_ID, runId: "turn" }, bytes: 10 };
  const finished = { sequence: 2, event: { type: EventType.RUN_FINISHED, threadId: SESSION_ID, runId: "turn" }, bytes: 10 };
  const reader = { disconnect: vi.fn() };
  const replay = vi.fn(async () => [started]);
  const waitForEvents = vi.fn(async () => [finished]);
  await registerSessionRoutes(app, {
    sessions: { getReadable }, activeTurns,
    executions: { currentOwner: async () => ({ executionId: "execution", ownerId: "other-replica" }) },
    turnBus: { replay, waitForEvents, reader: () => reader }
  } as unknown as SessionRouteStores);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${address}/sessions/${SESSION_ID}/events?after=0`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("id: 1\ndata:");
    expect(body).toContain("id: 2\ndata:");
    expect(replay).toHaveBeenCalledWith({ tenantId: "tenant", sessionId: SESSION_ID, executionId: "execution" }, 0);
    expect(waitForEvents).toHaveBeenCalled();
    expect(reader.disconnect).toHaveBeenCalled();
  } finally { await app.close(); }
});

test("remote events stop when read access is revoked during the Redis wait", async () => {
  const { app, activeTurns, getReadable } = makeApp();
  let readable = true;
  const session = { sessionId: SESSION_ID, status: "active", purpose: "normal", projectId: "project" };
  getReadable.mockImplementation(async () => readable ? session : null);
  const started = { sequence: 1, event: { type: EventType.RUN_STARTED, threadId: SESSION_ID, runId: "turn" }, bytes: 10 };
  const secret = { sequence: 2, event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: "private" }, bytes: 10 };
  await registerSessionRoutes(app, {
    sessions: { getReadable }, activeTurns,
    executions: { currentOwner: async () => ({ executionId: "execution", ownerId: "other-replica" }) },
    turnBus: { replay: async () => [started], waitForEvents: async () => {
      readable = false;
      return [secret];
    }, reader: () => ({ disconnect: vi.fn() }) }
  } as unknown as SessionRouteStores);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${address}/sessions/${SESSION_ID}/events?after=0`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("id: 1\ndata:");
    expect(body).not.toContain("private");
  } finally { await app.close(); }
});

test("a remote replay gap returns 409 before opening the stream", async () => {
  const { app, activeTurns, getReadable } = makeApp();
  await registerSessionRoutes(app, {
    sessions: { getReadable }, activeTurns,
    executions: { currentOwner: async () => ({ executionId: "execution", ownerId: "other-replica" }) },
    turnBus: { replay: async () => null }
  } as unknown as SessionRouteStores);
  try {
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/events?after=0` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("replay_gap");
  } finally { await app.close(); }
});
