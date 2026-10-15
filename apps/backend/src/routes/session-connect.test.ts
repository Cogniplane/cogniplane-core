import { EventType, type BaseEvent } from "@ag-ui/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import type { TurnEventLog } from "../services/turn-event-log.js";
import { sessionRoutesApp } from "../test-helpers/session-routes-app.js";

const SESSION_ID = "37af657a-2fed-4148-a5fa-ec6b34ccc959";
const SESSION = { sessionId: SESSION_ID, status: "active", purpose: "normal", projectId: "project", transcriptFormat: "current" };

afterEach(() => {
  vi.useRealTimers();
});

type Row = { messageId: string; role: "user" | "assistant"; status?: string; content?: string; planContent?: string };

function savedRow(row: Row) {
  return {
    sessionId: SESSION_ID, status: "completed", content: "", reasoningContent: "", reasoningSegments: null,
    planContent: "", toolResults: [], detail: {}, ...row
  };
}

const EARLIER = [
  savedRow({ messageId: "u1", role: "user", content: "Earlier question" }),
  savedRow({ messageId: "a1", role: "assistant", content: "Earlier answer", planContent: "- earlier plan" })
];
const RUNNING_USER = savedRow({ messageId: "u2", role: "user", content: "Second question" });
const SAVED_PARTIAL = savedRow({ messageId: "a2", role: "assistant", status: "streaming", content: "SAVED-PARTIAL" });

const ev = {
  runStarted: { type: EventType.RUN_STARTED, threadId: SESSION_ID, runId: "a2" } as BaseEvent,
  turnStarted: (messageId: string) => ({ type: EventType.CUSTOM, name: "turn_started", value: { messageId, sequence: 7 } }) as BaseEvent,
  text: (delta: string) => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "live-1", delta }) as BaseEvent,
  textStart: { type: EventType.TEXT_MESSAGE_START, messageId: "live-1", role: "assistant" } as BaseEvent,
  textEnd: { type: EventType.TEXT_MESSAGE_END, messageId: "live-1" } as BaseEvent,
  runFinished: { type: EventType.RUN_FINISHED, threadId: SESSION_ID, runId: "a2" } as BaseEvent
};

type Setup = {
  readable?: () => object | null;
  history?: () => Promise<{ messages: object[]; hasMore: boolean }>;
  executions?: object;
  turnBus?: object;
};

async function makeApp(setup: Setup = {}) {
  const activeTurns = new ActiveTurnsRegistry();
  const getReadable = vi.fn(async () => (setup.readable ? setup.readable() : SESSION));
  const listBySession = vi.fn(setup.history ?? (async () => ({ messages: [...EARLIER], hasMore: false })));
  const app = await sessionRoutesApp({
    sessions: { getReadable },
    messages: { listBySession },
    activeTurns,
    ...(setup.executions ? { executions: setup.executions } : {}),
    ...(setup.turnBus ? { turnBus: setup.turnBus } : {})
  }, { userId: "viewer" });
  return { app, activeTurns, getReadable, listBySession };
}

/** An execution on another replica owns the session. */
const REMOTE_OWNER = { currentOwner: async () => ({ executionId: "execution", ownerId: "other-replica" }) };

/** Opens a live connection over a real socket. */
async function openLive(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}/sessions/${SESSION_ID}/connect`);
  expect(response.status).toBe(200);
  return { reader: response.body!.getReader(), state: { body: "" } };
}

function markLocalTurn(activeTurns: ActiveTurnsRegistry, tenantId = "tenant"): TurnEventLog {
  activeTurns.mark(SESSION_ID, { tenantId, userId: "owner" });
  return activeTurns.eventLog(SESSION_ID, tenantId)!;
}

function listenerCount(log: TurnEventLog): number {
  return (log as unknown as { listeners: Set<unknown> }).listeners.size;
}

/** The AG-UI events of an SSE body, in order. */
function parseEvents(body: string): Array<Record<string, unknown>> {
  return body.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    return data ? [JSON.parse(data.slice("data: ".length)) as Record<string, unknown>] : [];
  });
}

function historyOf(events: Array<Record<string, unknown>>) {
  const snapshot = events.find((event) => event.type === EventType.MESSAGES_SNAPSHOT) as { messages: Array<{ id: string }> };
  const state = events.find((event) => event.type === EventType.STATE_SNAPSHOT) as { snapshot: unknown };
  const connection = events.find((event) => event.name === "session_connection") as { value: unknown };
  return { ids: snapshot.messages.map((message) => message.id), state: state.snapshot, connection: connection.value };
}

/** Reads a live response until `done` holds for the parsed events. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, state: { body: string }, done: (events: Array<Record<string, unknown>>) => boolean) {
  const decoder = new TextDecoder();
  while (!done(parseEvents(state.body))) {
    const next = await reader.read();
    if (next.done) throw new Error(`The stream ended early: ${state.body}`);
    state.body += decoder.decode(next.value);
  }
}

describe("GET /sessions/:id/connect access", () => {
  test("checks read access before it reads history or captures the turn", async () => {
    const { app, activeTurns, listBySession } = await makeApp({ readable: () => null });
    const log = markLocalTurn(activeTurns);
    log.append({ ...ev.text("private") });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("private");
    expect(listBySession).not.toHaveBeenCalled();
    expect(listenerCount(log)).toBe(0);
  });

  test("refuses an archived personal session, whose content is not browsable", async () => {
    const { app, listBySession } = await makeApp({ readable: () => ({ ...SESSION, status: "archived", projectId: null }) });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    expect(response.statusCode).toBe(404);
    expect(listBySession).not.toHaveBeenCalled();
  });

  test.each([
    ["legacy", "legacy"],
    ["unsupported", "unsupported"],
    ["absent", undefined]
  ] as const)("refuses a session with a %s history format before it reads history or captures the turn", async (_, transcriptFormat) => {
    const executions = { currentOwner: vi.fn(async () => ({ executionId: "remote" })) };
    const { app, activeTurns, listBySession } = await makeApp({
      readable: () => ({ ...SESSION, transcriptFormat }),
      executions
    });
    const log = markLocalTurn(activeTurns);
    log.append(ev.runStarted);
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "unsupported_transcript_format" });
    expect(listBySession).not.toHaveBeenCalled();
    expect(listenerCount(log)).toBe(0);
    expect(executions.currentOwner).not.toHaveBeenCalled();
  });

  test("does not attach a turn that runs under the same session id in another tenant", async () => {
    const { app, activeTurns } = await makeApp();
    const log = markLocalTurn(activeTurns, "other-tenant");
    log.append(ev.runStarted);
    log.append(ev.text("private"));
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("private");
    expect(historyOf(parseEvents(response.body)).connection).toEqual({ activeTurn: "none", hasMoreHistory: false });
  });

  test("releases the local capture when the history read fails", async () => {
    const { app, activeTurns } = await makeApp({ history: async () => { throw new Error("database down"); } });
    const log = markLocalTurn(activeTurns);
    log.append(ev.runStarted);
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    expect(response.statusCode).toBe(500);
    expect(listenerCount(log)).toBe(0);
  });
});

describe("GET /sessions/:id/connect history", () => {
  test("sends an idle session as one finished history run, with its truncation flag", async () => {
    const { app } = await makeApp({ history: async () => ({ messages: [...EARLIER], hasMore: true }) });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = parseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED, EventType.MESSAGES_SNAPSHOT, EventType.STATE_SNAPSHOT, EventType.CUSTOM, EventType.RUN_FINISHED
    ]);
    expect(events[0]).not.toHaveProperty("input");
    expect(historyOf(events)).toEqual({
      ids: ["u1", "a1"],
      state: { plan: "- earlier plan" },
      connection: { activeTurn: "none", hasMoreHistory: true }
    });
  });

  test("keeps the saved partial reply when the bounded log lost the start of the turn", async () => {
    const { app, activeTurns } = await makeApp({ history: async () => ({ messages: [...EARLIER, RUNNING_USER, SAVED_PARTIAL], hasMore: false }) });
    const log = markLocalTurn(activeTurns);
    log.append({ type: EventType.CUSTOM, name: "big", value: { text: "a".repeat(600_000) } } as BaseEvent);
    log.append({ type: EventType.CUSTOM, name: "big", value: { text: "b".repeat(600_000) } } as BaseEvent);
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const history = historyOf(parseEvents(response.body));
    expect(history.connection).toEqual({ activeTurn: "unavailable", hasMoreHistory: false });
    expect(history.ids).toEqual(["u1", "a1", "u2", "a2"]);
    expect(response.body).not.toContain("aaaa");
  });

  test("reports an unavailable turn, not an idle session, when the turn bus is missing", async () => {
    const { app } = await makeApp({
      history: async () => ({ messages: [...EARLIER, RUNNING_USER, SAVED_PARTIAL], hasMore: false }),
      executions: { currentOwner: async () => ({ executionId: "execution", ownerId: "other-replica" }) }
    });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const history = historyOf(parseEvents(response.body));
    expect(history.connection).toEqual({ activeTurn: "unavailable", hasMoreHistory: false });
    expect(history.ids).toContain("a2");
  });

  test.each([
    ["a failed remote replay", async () => { throw new Error("redis down"); }],
    ["a remote replay gap", async () => null]
  ])("reports %s as an unavailable turn", async (_, replay) => {
    const { app } = await makeApp({
      executions: REMOTE_OWNER,
      turnBus: { replay }
    });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    expect(response.statusCode).toBe(200);
    expect(historyOf(parseEvents(response.body)).connection).toEqual({ activeTurn: "unavailable", hasMoreHistory: false });
  });
});

describe("GET /sessions/:id/connect with a local turn", () => {
  test("sends history without the replayed reply, then the replay, then live events", async () => {
    const { app, activeTurns } = await makeApp({ history: async () => ({ messages: [...EARLIER, RUNNING_USER, SAVED_PARTIAL], hasMore: false }) });
    const log = markLocalTurn(activeTurns);
    log.append(ev.runStarted);
    log.append(ev.turnStarted("a2"));
    log.append(ev.textStart);
    log.append(ev.text("Working "));
    const { reader, state } = await openLive(app);
    // The turn log holds recent words for secret redaction, so the text
    // arrives when the message ends.
    await readUntil(reader, state, (events) => events.some((event) => event.type === EventType.TEXT_MESSAGE_START));
    const history = historyOf(parseEvents(state.body));
    expect(history.ids).toEqual(["u1", "a1", "u2"]);
    expect(history.connection).toEqual({ activeTurn: "attached", hasMoreHistory: false });
    expect(state.body).not.toContain("SAVED-PARTIAL");
    // The replay keeps the sequence ids of the turn log.
    expect(state.body).toContain("id: 1\ndata:");

    log.append(ev.text("on it."));
    log.append(ev.textEnd);
    log.append(ev.runFinished);
    log.close();
    await readUntil(reader, state, (events) => events.filter((event) => event.type === EventType.RUN_FINISHED).length === 2);
    expect((await reader.read()).done).toBe(true);
    const events = parseEvents(state.body);
    expect(events.slice(5).map((event) => event.type)).toEqual([
      EventType.RUN_STARTED, EventType.CUSTOM, EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED
    ]);
    expect(events.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)?.delta).toBe("Working on it.");
    expect(listenerCount(log)).toBe(0);
  });

  test("drops the named reply once when the turn finishes during the history read", async () => {
    const turn: { log?: TurnEventLog } = {};
    const { app, activeTurns } = await makeApp({
      history: async () => {
        // The turn ends after the capture and before this read returns. The
        // saved row is already complete.
        const log = turn.log!;
        log.append(ev.text("FULL-REPLY"));
        log.append(ev.textEnd);
        activeTurns.clear(SESSION_ID);
        log.append(ev.runFinished);
        log.close();
        return {
          messages: [...EARLIER, RUNNING_USER, savedRow({ messageId: "a2", role: "assistant", content: "FULL-REPLY" })],
          hasMore: false
        };
      }
    });
    const log = markLocalTurn(activeTurns);
    turn.log = log;
    log.append(ev.runStarted);
    log.append(ev.turnStarted("a2"));
    log.append(ev.textStart);
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const events = parseEvents(response.body);
    expect(historyOf(events).ids).toEqual(["u1", "a1", "u2"]);
    expect(events.filter((event) => event.delta === "FULL-REPLY")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  test("attaches a turn still in setup, whose empty reply row adds nothing to the history", async () => {
    const { app, activeTurns } = await makeApp({
      history: async () => ({
        messages: [...EARLIER, RUNNING_USER, savedRow({ messageId: "a2", role: "assistant", status: "pending" })],
        hasMore: false
      })
    });
    const log = markLocalTurn(activeTurns);
    const { reader, state } = await openLive(app);
    await readUntil(reader, state, (events) => events.some((event) => event.name === "session_connection"));
    expect(historyOf(parseEvents(state.body)).ids).toEqual(["u1", "a1", "u2"]);
    expect(historyOf(parseEvents(state.body)).connection).toEqual({ activeTurn: "attached", hasMoreHistory: false });
    // The turn starts after the connection. Its events follow live.
    log.append(ev.runStarted);
    log.append(ev.turnStarted("a2"));
    await readUntil(reader, state, (events) => events.some((event) => event.name === "turn_started"));
    await reader.cancel();
  });

  test("keeps an earlier unfinished reply when the turn in setup has not named its row", async () => {
    // A failed earlier turn left its row "streaming". The new turn has not
    // saved its prompt yet, so the newest reply is not its row.
    const crashed = savedRow({ messageId: "a-crashed", role: "assistant", status: "streaming", content: "CRASHED-PARTIAL" });
    const { app, activeTurns } = await makeApp({
      history: async () => ({ messages: [...EARLIER, RUNNING_USER, crashed], hasMore: false })
    });
    const log = markLocalTurn(activeTurns);
    const { reader, state } = await openLive(app);
    await readUntil(reader, state, (events) => events.some((event) => event.name === "session_connection"));
    expect(historyOf(parseEvents(state.body)).ids).toEqual(["u1", "a1", "u2", "a-crashed"]);
    expect(historyOf(parseEvents(state.body)).connection).toEqual({ activeTurn: "attached", hasMoreHistory: false });
    log.append(ev.runStarted);
    log.append(ev.turnStarted("a3"));
    await readUntil(reader, state, (events) => events.some((event) => event.name === "turn_started"));
    await reader.cancel();
  });

  test("ends the stream and keeps the saved reply when the capture overflows during the history read", async () => {
    const turn: { log?: TurnEventLog } = {};
    const { app, activeTurns } = await makeApp({
      history: async () => {
        for (let index = 0; index < 5; index += 1) {
          turn.log!.append({ type: EventType.CUSTOM, name: "large", value: { text: "x".repeat(250_000), index } } as BaseEvent);
        }
        return { messages: [...EARLIER, RUNNING_USER, SAVED_PARTIAL], hasMore: false };
      }
    });
    const log = markLocalTurn(activeTurns);
    turn.log = log;
    log.append(ev.runStarted);
    log.append(ev.turnStarted("a2"));
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const events = parseEvents(response.body);
    expect(historyOf(events).connection).toEqual({ activeTurn: "unavailable", hasMoreHistory: false });
    expect(historyOf(events).ids).toContain("a2");
    expect(events).toHaveLength(5);
    expect(listenerCount(log)).toBe(0);
  });

  test("a slow subscriber is removed as soon as its pending queue reaches the limit", async () => {
    const { app, activeTurns } = await makeApp();
    const log = markLocalTurn(activeTurns);
    log.append(ev.runStarted);
    const { reader, state } = await openLive(app);
    await readUntil(reader, state, (events) => events.filter((event) => event.type === EventType.RUN_STARTED).length === 2);
    // The first large frame exceeds the socket's write buffer. Keep the
    // reader idle while later events arrive in the same task.
    for (let index = 0; index < 6; index += 1) {
      log.append({ type: EventType.CUSTOM, name: "large", value: { text: "x".repeat(250_000), index } } as BaseEvent);
    }
    expect(listenerCount(log)).toBe(0);
    await reader.cancel();
  });

  test("ends the live stream when read access is revoked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let readable = true;
    const { app, activeTurns } = await makeApp({ readable: () => (readable ? SESSION : null) });
    const log = markLocalTurn(activeTurns);
    log.append(ev.runStarted);
    const { reader, state } = await openLive(app);
    await readUntil(reader, state, (events) => events.filter((event) => event.type === EventType.RUN_STARTED).length === 2);
    readable = false;
    await vi.advanceTimersByTimeAsync(20_000);
    log.append(ev.text("after revocation"));
    let next = await reader.read();
    while (!next.done) {
      state.body += new TextDecoder().decode(next.value);
      next = await reader.read();
    }
    expect(state.body).not.toContain("after revocation");
    expect(listenerCount(log)).toBe(0);
  });
});

describe("GET /sessions/:id/connect with a remote turn", () => {
  test("reads the bus again after history, drops the named reply, and stops when access is revoked", async () => {
    let readable = true;
    const started = { sequence: 1, event: ev.runStarted, bytes: 10 };
    const named = { sequence: 2, event: ev.turnStarted("a2"), bytes: 10 };
    const secret = { sequence: 3, event: ev.text("private"), bytes: 10 };
    const replay = vi.fn(async (_turn: unknown, after: number) => (after === 0 ? [started] : [named]));
    const reader = { disconnect: vi.fn() };
    const { app } = await makeApp({
      readable: () => (readable ? SESSION : null),
      history: async () => ({
        messages: [...EARLIER, RUNNING_USER, savedRow({ messageId: "a2", role: "assistant", content: "DONE-REPLY" })],
        hasMore: false
      }),
      executions: REMOTE_OWNER,
      turnBus: {
        replay,
        reader: () => reader,
        waitForEvents: async () => {
          readable = false;
          return [secret];
        }
      }
    });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const events = parseEvents(response.body);
    expect(historyOf(events).ids).toEqual(["u1", "a1", "u2"]);
    expect(historyOf(events).connection).toEqual({ activeTurn: "attached", hasMoreHistory: false });
    expect(replay.mock.calls.map(([, after]) => after)).toEqual([0, 1]);
    expect(events.some((event) => event.name === "turn_started")).toBe(true);
    expect(response.body).not.toContain("private");
    expect(reader.disconnect).toHaveBeenCalled();
  });

  test("reads the bus again after an empty first replay and drops the reply that turn_started names there", async () => {
    const replay = vi.fn(async (_turn: unknown, after: number) => (replay.mock.calls.length === 1
      ? []
      : [{ sequence: 1, event: ev.runStarted, bytes: 10 }, { sequence: 2, event: ev.turnStarted("a2"), bytes: 10 }]
        .filter((entry) => entry.sequence > after)));
    const { app } = await makeApp({
      history: async () => ({
        messages: [...EARLIER, RUNNING_USER, savedRow({ messageId: "a2", role: "assistant", content: "DONE-REPLY" })],
        hasMore: false
      }),
      executions: REMOTE_OWNER,
      turnBus: {
        replay,
        reader: () => ({ disconnect: vi.fn() }),
        waitForEvents: async () => [
          { sequence: 3, event: ev.textStart, bytes: 10 },
          { sequence: 4, event: ev.text("DONE-REPLY"), bytes: 10 },
          { sequence: 5, event: ev.textEnd, bytes: 10 },
          { sequence: 6, event: ev.runFinished, bytes: 10 }
        ]
      }
    });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const events = parseEvents(response.body);
    expect(replay.mock.calls.map(([, after]) => after)).toEqual([0, 0]);
    expect(historyOf(events).ids).toEqual(["u1", "a1", "u2"]);
    expect(historyOf(events).connection).toEqual({ activeTurn: "attached", hasMoreHistory: false });
    expect(response.body.split("DONE-REPLY")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  test.each([
    ["an empty bus", [], savedRow({ messageId: "a2", role: "assistant", content: "SAVED-REPLY" })],
    ["a bus that has only RUN_STARTED", [{ sequence: 1, event: ev.runStarted, bytes: 10 }],
      savedRow({ messageId: "a2", role: "assistant", content: "SAVED-REPLY" })],
    ["an empty bus and a partial reply", [], savedRow({ messageId: "a2", role: "assistant", status: "streaming", content: "SAVED-REPLY" })]
  ])("sends the history as it is and reports an unavailable turn when the bus lags behind a saved reply: %s", async (_, firstReplay, reply) => {
    // The owner saved the reply, but its bus mirror has not sent turn_started
    // yet. Without that name, the saved row and the replay would both show
    // the reply.
    const replay = vi.fn(async () => (replay.mock.calls.length === 1 ? [...firstReplay] : []));
    const reader = vi.fn(() => ({ disconnect: vi.fn() }));
    const waitForEvents = vi.fn(async () => [
      { sequence: 2, event: ev.turnStarted("a2"), bytes: 10 },
      { sequence: 3, event: ev.text("SAVED-REPLY"), bytes: 10 },
      { sequence: 4, event: ev.runFinished, bytes: 10 }
    ]);
    const { app } = await makeApp({
      history: async () => ({ messages: [...EARLIER, RUNNING_USER, reply], hasMore: false }),
      executions: REMOTE_OWNER,
      turnBus: { replay, reader, waitForEvents }
    });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const events = parseEvents(response.body);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(historyOf(events).ids).toEqual(["u1", "a1", "u2", "a2"]);
    expect(historyOf(events).connection).toEqual({ activeTurn: "unavailable", hasMoreHistory: false });
    expect(response.body.split("SAVED-REPLY")).toHaveLength(2);
    expect(events).toHaveLength(5);
    expect(reader).not.toHaveBeenCalled();
    expect(waitForEvents).not.toHaveBeenCalled();
  });

  test.each([
    ["before its reply row exists", [...EARLIER, RUNNING_USER]],
    ["with its empty reply row", [...EARLIER, RUNNING_USER, savedRow({ messageId: "a2", role: "assistant", status: "pending" })]]
  ])("attaches a remote turn in setup %s and keeps the earlier turns", async (_, saved) => {
    const { app } = await makeApp({
      history: async () => ({ messages: saved, hasMore: false }),
      executions: REMOTE_OWNER,
      turnBus: {
        replay: async () => [],
        reader: () => ({ disconnect: vi.fn() }),
        waitForEvents: async () => [
          { sequence: 1, event: ev.runStarted, bytes: 10 },
          { sequence: 2, event: ev.turnStarted("a2"), bytes: 10 },
          { sequence: 3, event: ev.text("LIVE-REPLY"), bytes: 10 },
          { sequence: 4, event: ev.runFinished, bytes: 10 }
        ]
      }
    });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const events = parseEvents(response.body);
    expect(historyOf(events).ids).toEqual(["u1", "a1", "u2"]);
    expect(historyOf(events).connection).toEqual({ activeTurn: "attached", hasMoreHistory: false });
    expect(response.body.split("LIVE-REPLY")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  test("ends when another execution owns the session", async () => {
    let owner = "execution";
    const { app } = await makeApp({
      history: async () => ({ messages: [...EARLIER, RUNNING_USER], hasMore: false }),
      executions: { currentOwner: async () => ({ executionId: owner, ownerId: "other-replica" }) },
      turnBus: {
        replay: async (_turn: unknown, after: number) =>
          [{ sequence: 1, event: ev.runStarted, bytes: 10 }].filter((entry) => entry.sequence > after),
        reader: () => ({ disconnect: vi.fn() }),
        waitForEvents: async () => {
          owner = "next-execution";
          return [];
        }
      }
    });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    const events = parseEvents(response.body);
    expect(events.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(2);
    expect(events.at(-1)?.type).toBe(EventType.RUN_STARTED);
  });
});

// The real execution store reads its pool through `this`. A quiet interval of
// the bus makes the stream ask it for the owner of the session. Each query of
// the fake pool returns the current owner row; the transaction statements
// ignore it.
describe("GET /sessions/:id/connect with a quiet remote turn and the execution store", () => {
  function executionStore() {
    const state = { owner: "execution", connections: 0 };
    const client = {
      query: async () => ({ rows: [{ execution_id: state.owner, owner_id: "other-replica" }] }),
      release: () => undefined
    };
    const pool = { connect: async () => { state.connections += 1; return client; } };
    return { store: new SessionExecutionStore(pool as never, "this-replica"), state };
  }

  type Owner = ReturnType<typeof executionStore>["state"];
  type Entry = { sequence: number; event: BaseEvent; bytes: number };
  async function streamRemote(waitForEvents: (owner: Owner) => Promise<Entry[]>, readable?: () => object | null) {
    const { store, state } = executionStore();
    const wait = vi.fn(async () => waitForEvents(state));
    const { app } = await makeApp({
      readable,
      history: async () => ({ messages: [...EARLIER, RUNNING_USER], hasMore: false }),
      executions: store,
      turnBus: {
        replay: async (_turn: unknown, after: number) => [
          { sequence: 1, event: ev.runStarted, bytes: 10 },
          { sequence: 2, event: ev.turnStarted("a2"), bytes: 10 }
        ].filter((entry) => entry.sequence > after),
        reader: () => ({ disconnect: vi.fn() }),
        waitForEvents: wait
      }
    });
    const response = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/connect` });
    return { body: response.body, events: parseEvents(response.body), wait, state };
  }

  test("stays open through the interval and ends at the terminal event", async () => {
    const live = [[], [
      { sequence: 3, event: ev.textStart, bytes: 10 },
      { sequence: 4, event: ev.text("LIVE-REPLY"), bytes: 10 },
      { sequence: 5, event: ev.runFinished, bytes: 10 }
    ]];
    const { body, events, wait, state } = await streamRemote(async () => live.shift() ?? []);

    expect(wait).toHaveBeenCalledTimes(2);
    expect(body).toContain(": keep-alive");
    expect(body.split("LIVE-REPLY")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    // Once to find the turn, once after the quiet interval.
    expect(state.connections).toBe(2);
  });

  test("ends after the interval when the store reports another execution", async () => {
    const { body, events, wait, state } = await streamRemote(async (owner) => {
      owner.owner = "next-execution";
      return [];
    });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(body).not.toContain(": keep-alive");
    expect(events.at(-1)?.type).not.toBe(EventType.RUN_FINISHED);
    expect(state.connections).toBe(2);
  });

  test("ends when the requester loses access after a quiet interval", async () => {
    let readable = true;
    const { body, events, wait, state } = await streamRemote(async () => {
      readable = false;
      return [];
    }, () => (readable ? SESSION : null));

    expect(wait).toHaveBeenCalledTimes(1);
    expect(body).toContain(": keep-alive");
    expect(events.at(-1)?.type).not.toBe(EventType.RUN_FINISHED);
    expect(state.connections).toBe(2);
  });
});
