// @vitest-environment jsdom
// Runs a real DeepAgentsBrowserAgent through @ag-ui/client against stubbed
// SSE bodies. It checks which subscriber callbacks the library calls when a
// stream drops, closes early, or ends with RUN_ERROR, and how the session
// connection classifies each end. A fake agent cannot prove this.
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-client", () => ({
  API_URL: "http://api.test",
  createApiHeaders: (init?: HeadersInit) => new Headers(init),
  refreshAccessToken: vi.fn(),
  request: vi.fn()
}));
// A lost stream starts the poll of the saved state. The server still runs
// the turn.
vi.mock("../session-api", () => ({
  listSessions: vi.fn(async () => ({ sessions: [{ sessionId: "s-1", isRunning: true }] })),
  listApprovals: vi.fn(async () => [])
}));
vi.mock("../message-api", () => ({ listMessages: vi.fn(async () => ({ messages: [], hasMore: false })) }));

import { renderSessionHooks } from "../../test-helpers/agui-session-hooks";
import { DeepAgentsBrowserAgent } from "./deep-agents-browser-agent";

// The library must report a broken stream to the run, not as a stray
// rejection, and the backend's events must pass its enforcement as they are.
const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => { unhandled.push(reason); };
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", recordUnhandled);
  warn = vi.spyOn(console, "warn");
});

afterEach(async () => {
  // A rejection is reported after the microtasks of its tick.
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", recordUnhandled);
  expect(unhandled).toEqual([]);
  expect(warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes("[ag-ui]"))).toEqual([]);
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
const RUN_STARTED = frame({ type: "RUN_STARTED", threadId: "s-1", runId: "r-1" });

// One chunk per pull, then a clean close.
function stubStream(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
        else controller.close();
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  )));
}

async function runTurn() {
  const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
  const hooks = renderSessionHooks(agent);
  agent.addMessage({ id: "u-1", role: "user", content: "hi" });
  await act(async () => {
    await agent.runAgent().catch(() => undefined);
  });
  return { agent, ...hooks };
}

describe("the end of a stream through @ag-ui/client", () => {
  // A message stream starts with the turn. A session connection starts with
  // the saved history, then the attached turn. The network fails after the
  // turn started.
  const HISTORY = [
    frame({ type: "RUN_STARTED", threadId: "s-1", runId: "history:1" }),
    frame({ type: "MESSAGES_SNAPSHOT", messages: [] }),
    frame({ type: "CUSTOM", name: "session_connection", value: { activeTurn: "attached", hasMoreHistory: false } }),
    frame({ type: "RUN_FINISHED", threadId: "s-1", runId: "history:1" })
  ].join("");
  // The hook handles a lost connection: @ag-ui/client does not log or rethrow
  // its failure, and CopilotKit does not see it. A message run still fails.
  it.each([
    ["runAgent", RUN_STARTED, 1, true],
    ["connectAgent", HISTORY + RUN_STARTED, 2, false]
  ] as const)("%s reports a network error after the turn started as a lost stream", async (method, opening, turnStart, rethrown) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        controller.enqueue(new TextEncoder().encode(opening));
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: { "Content-Type": "text/event-stream" }
    })));
    // @ag-ui/client logs the rethrown run error; it is expected here.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const { result, onTurnSettled } = renderSessionHooks(agent);
    agent.addMessage({ id: "u-1", role: "user", content: "hi" });
    let starts = 0;
    let thrown: unknown = null;
    await act(async () => {
      await agent[method](undefined, {
        onRunStartedEvent: () => {
          starts += 1;
          if (starts === turnStart) controller.error(new TypeError("network error"));
        }
      }).catch((error: unknown) => { thrown = error; });
    });

    expect(result.current.connection).toMatchObject({ running: false, remoteRunning: true, activity: null });
    expect(onTurnSettled).not.toHaveBeenCalled();
    expect(thrown !== null).toBe(rethrown);
    // The reader is not cancelled after its error, so nothing else is logged.
    expect(errors.mock.calls.map(([first]) => String(first))).toEqual(rethrown ? ["Agent execution failed:"] : []);
  });

  // The terminal event ends the turn once, with its outcome. A transport
  // failure after it changes nothing for a connection; a message run still
  // fails.
  it.each([
    ["connectAgent", "RUN_FINISHED"],
    ["connectAgent", "RUN_ERROR"],
    ["runAgent", "RUN_FINISHED"],
    ["runAgent", "RUN_ERROR"]
  ] as const)("%s ends the turn once at %s when the transport fails after it", async (method, terminal) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const opening = (method === "connectAgent" ? HISTORY : "") + RUN_STARTED + (terminal === "RUN_FINISHED"
      ? frame({ type: "RUN_FINISHED", threadId: "s-1", runId: "r-1" })
      : frame({ type: "RUN_ERROR", message: "graph failed" }));
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        controller.enqueue(new TextEncoder().encode(opening));
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: { "Content-Type": "text/event-stream" }
    })));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const { result, onTurnSettled, connect } = renderSessionHooks(agent);
    agent.addMessage({ id: "u-1", role: "user", content: "hi" });
    const fail = () => controller.error(new TypeError("network error"));
    let finished = 0;
    let thrown: unknown = null;
    await act(async () => {
      await agent[method](undefined, {
        onRunFinishedEvent: () => {
          finished += 1;
          if (finished === (method === "connectAgent" ? 2 : 1)) fail();
        },
        onRunErrorEvent: fail
      }).catch((error: unknown) => { thrown = error; });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(result.current.connection).toMatchObject({ running: false, remoteRunning: false });
    expect(result.current.connection.activity).toEqual(method === "runAgent"
      ? expect.objectContaining({ isRunning: false, failed: terminal === "RUN_ERROR" })
      : null);
    expect(connect).not.toHaveBeenCalled();
    const rethrown = method === "runAgent";
    expect(thrown !== null).toBe(rethrown);
    expect(errors.mock.calls.map(([first]) => String(first))).toEqual(rethrown ? ["Agent execution failed:"] : []);
  });

  it("reports a stream that closes before a terminal event as lost", async () => {
    stubStream([RUN_STARTED]);
    const { result, onTurnSettled } = await runTurn();

    expect(result.current.connection.remoteRunning).toBe(true);
    expect(onTurnSettled).not.toHaveBeenCalled();
  });

  it("ends the turn as failed once on RUN_ERROR, because the backend ended the turn", async () => {
    stubStream([RUN_STARTED, frame({ type: "RUN_ERROR", message: "graph failed" })]);
    const { result, onTurnSettled } = await runTurn();

    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(result.current.connection).toMatchObject({ running: false, remoteRunning: false });
    expect(result.current.connection.activity).toMatchObject({ isRunning: false, failed: true });
  });

  it("ends the turn once on RUN_FINISHED and clears approvals that it left", async () => {
    stubStream([
      RUN_STARTED,
      frame({ type: "CUSTOM", name: "approval_required", value: { approvalId: "ap-1", itemId: "i", kind: "command_execution", title: "Run", summary: "ls" } }),
      frame({ type: "RUN_FINISHED", threadId: "s-1", runId: "r-1" })
    ]);
    const { result, onTurnSettled } = await runTurn();

    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(result.current.events.approvals).toEqual([]);
    expect(result.current.connection.activity).toMatchObject({ isRunning: false, failed: false });
  });

  describe("a connection that the server does not serve", () => {
    async function connectWith(status: number) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: "refused", message: `Status ${status}` }),
        { status, headers: { "Content-Type": "application/json" } }
      )));
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
      const hooks = renderSessionHooks(agent);
      let thrown: unknown = null;
      await act(async () => {
        await agent.connectAgent().catch((error: unknown) => { thrown = error; });
      });
      return { ...hooks, thrown };
    }

    it.each([429, 500, 502, 503, 504])("connects again after HTTP %i, which can pass", async (status) => {
      const { result, connect, thrown } = await connectWith(status);

      await waitFor(() => expect(connect).toHaveBeenCalledOnce());
      expect(result.current.connection).toMatchObject({ refusal: null, historyRestored: false });
      // CopilotKit does not see the failure, so CopilotChat keeps sends open.
      expect(thrown).toBeNull();
    });

    it.each([401, 403, 404, 409])("refuses for good after HTTP %i", async (status) => {
      const { result, connect, thrown } = await connectWith(status);

      expect(result.current.connection.refusal).toEqual({ status, message: `Status ${status}` });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(connect).not.toHaveBeenCalled();
      expect(result.current.connection.remoteRunning).toBe(false);
      expect(thrown).toMatchObject({ status });
    });
  });

  it("connects again when RUN_ERROR ends a connection before its history", async () => {
    stubStream([frame({ type: "RUN_ERROR", message: "history read failed" })]);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const { result, connect, onTurnSettled } = renderSessionHooks(agent);

    await act(async () => { await agent.connectAgent(); });

    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(result.current.connection).toMatchObject({ historyRestored: false, running: false, remoteRunning: false, refusal: null });
    expect(onTurnSettled).not.toHaveBeenCalled();
  });

  // cr1 R5: sends wait while a planned connection waits. A connection that
  // ends without a run releases only its own plan, not a newer one.
  it("keeps sends blocked for a newer planned connection when an older connection ends without a run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubStream([
      frame({ type: "RUN_STARTED", threadId: "s-1", runId: "history:1" }),
      frame({ type: "MESSAGES_SNAPSHOT", messages: [] }),
      frame({ type: "CUSTOM", name: "session_connection", value: { activeTurn: "none", hasMoreHistory: false } }),
      frame({ type: "RUN_FINISHED", threadId: "s-1", runId: "history:1" })
    ]);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const { result, rerender, connect } = renderSessionHooks(agent);
    await act(async () => { await agent.connectAgent(); });
    expect(result.current.connection.ready).toBe(true);
    // The connections that the hook starts stay open until the test ends them.
    const endConnection: Array<() => void> = [];
    connect.mockImplementation(() => new Promise<undefined>((resolve) => { endConnection.push(() => resolve(undefined)); }));

    // Another tab starts a turn: the first plan connects at once.
    rerender({ serverRunning: true });
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    // The list reports the end and a new start: the second plan waits for
    // the interval after the first connection.
    rerender({ serverRunning: false });
    rerender({ serverRunning: true });
    await act(async () => { endConnection[0]!(); });

    expect(result.current.connection).toMatchObject({ ready: false, busy: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(result.current.connection.ready).toBe(false);
    // The second connection ends without a run: nothing is left to wait for.
    await act(async () => { endConnection[1]!(); });
    expect(result.current.connection.ready).toBe(true);
  });

  it("does not report this tab's abort as a lost stream or an ended turn", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        controller.enqueue(new TextEncoder().encode(RUN_STARTED));
        init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      }
    }), { headers: { "Content-Type": "text/event-stream" } })));
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const { result, onTurnSettled } = renderSessionHooks(agent);
    agent.addMessage({ id: "u-1", role: "user", content: "hi" });
    let done!: Promise<unknown>;
    act(() => { done = agent.runAgent(); });
    await waitFor(() => expect(result.current.connection.running).toBe(true));
    await act(async () => {
      agent.abortRun();
      await done;
    });

    expect(result.current.connection).toMatchObject({ running: true, remoteRunning: false });
    expect(onTurnSettled).not.toHaveBeenCalled();
  });
});

it("keeps a transformed user message after later reply events complete the real agent run", async () => {
  stubStream([
    RUN_STARTED,
    frame({ type: "CUSTOM", name: "user_message_replaced", value: {
      messageId: "server-id", text: "my card is [REDACTED]"
    } }),
    frame({ type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" }),
    frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "Received safely" }),
    frame({ type: "TEXT_MESSAGE_END", messageId: "a2" }),
    frame({ type: "RUN_FINISHED", threadId: "s-1", runId: "r-1" })
  ]);
  // The browser agent applies the replacement itself; no hook is mounted.
  const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
  // An earlier turn and the optimistic user message of this send.
  agent.setMessages([
    { id: "u1", role: "user", content: "first" },
    { id: "a1", role: "assistant", content: "reply" },
    { id: "u2", role: "user", content: "my card is 4111 1111 1111 1111" }
  ]);
  await act(async () => { await agent.runAgent(); });

  expect(agent.messages).toEqual([
    { id: "u1", role: "user", content: "first" },
    { id: "a1", role: "assistant", content: "reply" },
    { id: "u2", role: "user", content: "my card is [REDACTED]" },
    { id: "a2", role: "assistant", content: "Received safely" }
  ]);
});
