// The connection reducer as transition tables. copilot-chat-host.test.tsx
// runs the same transitions through the real CopilotKit and @ag-ui/client.
import { describe, expect, it } from "vitest";

import {
  connectionReducer,
  initialConnectionState,
  isStreamLossError,
  reconnectDelay,
  type ConnectionEvent,
  type ConnectionState
} from "./use-session-connection";

const AT = "2026-10-12T10:00:00.000Z";
const idle = (): ConnectionState => ({ ...initialConnectionState(false), view: "ready" });
const streaming = (): ConnectionState => connectionReducer(idle(), { type: "send_started", at: AT });
const remote = (): ConnectionState => connectionReducer(streaming(), { type: "stream_lost" });

const run = (state: ConnectionState, ...events: ConnectionEvent[]) => events.reduce(connectionReducer, state);

describe("connectionReducer transitions", () => {
  it.each<[string, () => ConnectionState, ConnectionEvent, Partial<ConnectionState>]>([
    ["a connection starts loading", idle, { type: "connect_started" }, { view: "loading", pending: false }],
    ["a refused view stays refused", () => ({ ...idle(), view: "refused" }), { type: "connect_started" }, { view: "refused" }],
    ["an idle history restores", () => initialConnectionState(false), { type: "history", activeTurn: "none", hasMoreHistory: true },
      { view: "ready", turn: "none", truncated: true, settles: 0 }],
    ["an attached history streams", () => initialConnectionState(false), { type: "history", activeTurn: "attached", hasMoreHistory: false },
      { view: "ready", turn: "streaming", settles: 0 }],
    ["an unavailable turn polls", () => initialConnectionState(false), { type: "history", activeTurn: "unavailable", hasMoreHistory: false },
      { view: "ready", turn: "remote", poll: 1 }],
    ["a history without a turn ends a remote turn", remote, { type: "history", activeTurn: "none", hasMoreHistory: false },
      { turn: "none", settles: 1 }],
    ["a history that attaches keeps the turn open", remote, { type: "history", activeTurn: "attached", hasMoreHistory: false },
      { turn: "streaming", settles: 0 }],
    ["a lost connection plans another one", idle, { type: "connection_lost" },
      { failures: 1, pending: true, nextConnection: { failures: 1 } }],
    ["a refused connection is final", idle, { type: "connection_refused", refusal: { status: 409, message: "Old format." } },
      { view: "refused", refusal: { status: 409, message: "Old format." }, pending: false, nextConnection: null }],
    ["a send streams", idle, { type: "send_started", at: AT },
      { turn: "streaming", activity: { startedAt: AT, isRunning: true, failed: false } }],
    ["a busy refusal shows the other turn", streaming, { type: "send_refused", busy: true },
      { turn: "remote", busyRefused: true, activity: null, pending: true, poll: 1, settles: 0 }],
    ["another refusal ends nothing", streaming, { type: "send_refused", busy: false },
      { turn: "none", activity: null, settles: 0, pending: false }],
    ["turn_started names the turn", streaming, { type: "turn_identified", turnId: "a-1", sequence: 4 },
      { activity: { startedAt: AT, isRunning: true, failed: false, turnId: "a-1", turnSequence: 4 } }],
    ["a terminal event ends the turn", streaming, { type: "turn_ended", failed: true },
      { turn: "none", settles: 1, activity: { startedAt: AT, isRunning: false, failed: true } }],
    ["a lost stream polls and reconnects", streaming, { type: "stream_lost" },
      { turn: "remote", activity: null, pending: true, poll: 1 }],
    ["Stop closes the stream and polls", streaming, { type: "stream_closed" }, { turn: "remote", poll: 1, settles: 0 }],
    ["Stop without a turn does nothing", idle, { type: "stream_closed" }, { turn: "none", poll: 0 }],
    ["the end of a remote turn loads the final state", remote, { type: "remote_ended" },
      { turn: "none", settles: 1, pending: true }],
    ["a late remote end does nothing", idle, { type: "remote_ended" }, { settles: 0, pending: false }],
    ["another tab's start connects", idle, { type: "server_running", running: true },
      { serverRunning: true, pending: true, nextConnection: { failures: 0 } }],
    ["the saved end polls at once", () => ({ ...remote(), serverRunning: true }), { type: "server_running", running: false },
      { serverRunning: false, poll: 2 }],
    ["a refused view plans nothing", () => ({ ...idle(), view: "refused" }), { type: "server_running", running: true },
      { pending: false, nextConnection: null }]
  ])("%s", (_, from, event, expected) => {
    expect(connectionReducer(from(), event)).toMatchObject(expected);
  });

  it("returns the same state for a repeated running state", () => {
    const state = idle();
    expect(connectionReducer(state, { type: "server_running", running: false })).toBe(state);
  });

  describe.each([
    ["403", { status: 403, message: null }],
    ["unsupported-format 409", { status: 409, message: "Not supported." }]
  ] as const)("a %s refusal of the reconnect after an attached stream drops", (_, refusal) => {
    const refused = () => run(initialConnectionState(true),
      { type: "connect_started" }, { type: "history", activeTurn: "attached", hasMoreHistory: false },
      { type: "stream_lost" }, { type: "connect_started" }, { type: "connection_refused", refusal });

    it("stops the poll and the turn, without a refresh or another connection", () => {
      expect(refused()).toMatchObject({
        view: "refused", refusal, turn: "none", activity: null, busyRefused: false,
        pending: false, nextConnection: null, settles: 0
      });
    });

    it.each<ConnectionEvent>([
      { type: "remote_ended" },
      { type: "poll" },
      { type: "stream_lost" },
      { type: "stream_closed" },
      { type: "turn_ended", failed: false },
      { type: "connection_lost" },
      { type: "connect_started" },
      { type: "history", activeTurn: "attached", hasMoreHistory: false },
      { type: "send_refused", busy: true }
    ])("ignores a late $type", (event) => {
      const state = refused();
      expect(connectionReducer(state, event)).toBe(state);
    });

    it("keeps the running state of the session list without a poll or a connection", () => {
      const stopped = run(refused(), { type: "server_running", running: false });
      expect(stopped).toEqual({ ...refused(), serverRunning: false });
      expect(run(stopped, { type: "server_running", running: true })).toEqual(refused());
    });
  });

  it("releases only the plan whose connection ended without a run", () => {
    const first = run(idle(), { type: "connection_lost" });
    const second = run(first, { type: "connection_lost" });
    expect(connectionReducer(second, { type: "connect_skipped", plan: first.nextConnection! })).toBe(second);
    expect(connectionReducer(second, { type: "connect_skipped", plan: second.nextConnection! })).toMatchObject({ pending: false });
  });

  it("plans a new connection object each time, with the failures at that time", () => {
    const first = run(idle(), { type: "connection_lost" });
    const second = run(first, { type: "connect_started" }, { type: "connection_lost" });
    expect(second.nextConnection).not.toBe(first.nextConnection);
    expect(second.nextConnection).toEqual({ failures: 2 });
    expect(run(second, { type: "connect_started" }, { type: "history", activeTurn: "none", hasMoreHistory: false }).failures).toBe(0);
  });
});

describe("one refresh per turn", () => {
  const settlesOf = (...events: ConnectionEvent[]) => run(initialConnectionState(false), ...events).settles;
  const restored: ConnectionEvent[] = [{ type: "connect_started" }, { type: "history", activeTurn: "none", hasMoreHistory: false }];

  it.each<[string, ConnectionEvent[], number]>([
    ["a restore", restored, 0],
    ["a send that finishes", [...restored, { type: "send_started", at: AT }, { type: "turn_ended", failed: false }], 1],
    ["a send that fails twice through onRunFailed and finalize", [...restored, { type: "send_started", at: AT },
      { type: "turn_ended", failed: true }, { type: "turn_ended", failed: true }], 1],
    ["a lost stream that a poll ends, then a connection that finds no turn", [...restored, { type: "send_started", at: AT },
      { type: "stream_lost" }, { type: "remote_ended" }, { type: "connect_started" },
      { type: "history", activeTurn: "none", hasMoreHistory: false }], 1],
    ["a lost stream that a new connection ends", [...restored, { type: "send_started", at: AT }, { type: "stream_lost" },
      { type: "connect_started" }, { type: "history", activeTurn: "none", hasMoreHistory: false }, { type: "remote_ended" }], 1],
    ["an attached turn whose stream drops, then attaches again and finishes", [{ type: "connect_started" },
      { type: "history", activeTurn: "attached", hasMoreHistory: false }, { type: "stream_lost" }, { type: "connect_started" },
      { type: "history", activeTurn: "attached", hasMoreHistory: false }, { type: "turn_ended", failed: false }], 1],
    ["an attached turn whose stream drops, then the server refuses the reconnect and the poll ends late", [
      { type: "connect_started" }, { type: "history", activeTurn: "attached", hasMoreHistory: false }, { type: "stream_lost" },
      { type: "connect_started" }, { type: "connection_refused", refusal: { status: 403, message: null } },
      { type: "remote_ended" }], 0],
    ["Stop, then the poll finds the end",[...restored, { type: "send_started", at: AT }, { type: "stream_closed" },
      { type: "remote_ended" }], 1],
    ["a busy refusal, then the other turn ends", [...restored, { type: "send_started", at: AT },
      { type: "send_refused", busy: true }, { type: "remote_ended" }], 1],
    ["a refused send", [...restored, { type: "send_started", at: AT }, { type: "send_refused", busy: false }], 0]
  ])("%s", (_, events, settles) => {
    expect(settlesOf(...events)).toBe(settles);
  });
});

describe("reconnectDelay", () => {
  it("connects at once the first time, then doubles the interval up to 30 s", () => {
    expect(reconnectDelay(1, 0, 10_000)).toBe(0);
    expect(reconnectDelay(1, 10_000, 10_000)).toBe(3_000);
    expect(reconnectDelay(2, 10_000, 10_000)).toBe(6_000);
    expect(reconnectDelay(3, 10_000, 11_000)).toBe(11_000);
    expect(reconnectDelay(20, 10_000, 10_000)).toBe(30_000);
  });
});

describe("isStreamLossError", () => {
  it("matches errors from the stream, not refusals or aborts", () => {
    expect(isStreamLossError(new TypeError("network error"))).toBe(true);
    expect(isStreamLossError(new Error("Cannot send event type 'TEXT_MESSAGE_CONTENT'"))).toBe(true);
    expect(isStreamLossError(Object.assign(new Error("HTTP 500"), { status: 500 }))).toBe(false);
    expect(isStreamLossError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isStreamLossError(new Error("signal is aborted without reason"))).toBe(false);
    expect(isStreamLossError("component unmounted")).toBe(false);
  });
});
