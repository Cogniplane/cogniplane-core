// @vitest-environment jsdom
import { EventType, type RunAgentInput } from "@ag-ui/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const refreshAccessToken = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ token: "tok-1" }));
vi.mock("../api-client", () => ({
  API_URL: "http://api.test",
  createApiHeaders: (init?: HeadersInit) => {
    const headers = new Headers(init);
    headers.set("Authorization", `Bearer ${auth.token}`);
    return headers;
  },
  refreshAccessToken
}));

import { DeepAgentsBrowserAgent, isReconnectRun, isSessionBusyError } from "./deep-agents-browser-agent";

// requestInit is protected; the subclass only widens visibility.
class ProbeAgent extends DeepAgentsBrowserAgent {
  buildRequestInit(input: RunAgentInput): RequestInit {
    return this.requestInit(input);
  }
}

function runInput(messages: Array<{ role: string; content: unknown }>): RunAgentInput {
  return {
    threadId: "s-1",
    runId: "r-1",
    messages: messages.map((m, i) => ({ id: `m-${i}`, ...m })),
    tools: [],
    context: [],
    state: {},
    forwardedProps: {}
  } as unknown as RunAgentInput;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  refreshAccessToken.mockReset();
  auth.token = "tok-1";
});

describe("DeepAgentsBrowserAgent.requestInit", () => {
  it("sends our body shape, deriving text from the latest user message", () => {
    const agent = new ProbeAgent({ sessionId: "s-1" });

    const body = bodyOf(
      agent.buildRequestInit(
        runInput([
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "the one that matters" }
        ])
      )
    );

    // The backend takes { sessionId, text, … }, not AG-UI's RunAgentInput.
    expect(body).toEqual({ sessionId: "s-1", text: "the one that matters" });
  });

  it("reads per-turn inputs through the getters at send time, not at construction", () => {
    let model = "zai/glm-4.7";
    let effort: string | null = "low";
    let artifactIds: string[] = [];
    let projectFileIds: string[] = [];
    const agent = new ProbeAgent({
      sessionId: "s-1",
      getModel: () => model,
      getEffort: () => effort as never,
      getArtifactIds: () => artifactIds,
      getProjectFileIds: () => projectFileIds
    });

    expect(bodyOf(agent.buildRequestInit(runInput([{ role: "user", content: "hi" }])))).toEqual({
      sessionId: "s-1",
      text: "hi",
      model: "zai/glm-4.7",
      effort: "low"
    });

    // Changing them must NOT need a new agent — reconstructing would rebind
    // CopilotKit and wipe the live transcript.
    model = "openai/gpt-5.4";
    effort = null;
    artifactIds = ["a-1", "a-2"];
    projectFileIds = ["file-1"];

    expect(bodyOf(agent.buildRequestInit(runInput([{ role: "user", content: "hi" }])))).toEqual({
      sessionId: "s-1",
      text: "hi",
      model: "openai/gpt-5.4",
      artifactIds: ["a-1", "a-2"],
      projectFileIds: ["file-1"]
    });
  });

  it("sends empty text when there is no user message, or its content is not a string", () => {
    const agent = new ProbeAgent({ sessionId: "s-1" });

    const noUser = bodyOf(agent.buildRequestInit(runInput([{ role: "assistant", content: "hi" }])));
    expect(noUser.text).toBe("");

    // A multi-part (image) message has array content; the backend wants a string.
    const nonString = bodyOf(
      agent.buildRequestInit(runInput([{ role: "user", content: [{ type: "image" }] }]))
    );
    expect(nonString.text).toBe("");
  });
});

describe("DeepAgentsBrowserAgent auth retry", () => {
  it("retries once with a refreshed token after a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    refreshAccessToken.mockImplementation(async () => {
      auth.token = "tok-2";
      return auth.token;
    });

    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const response = await agent.fetch("http://api.test/messages?format=agui", { method: "POST" });

    expect(response.status).toBe(200);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
    expect(requests.map((init) => new Headers(init.headers).get("Authorization")))
      .toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(requests.map((init) => init.credentials)).toEqual(["include", "include"]);
  });

  it("does not retry when the refresh yields no token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    refreshAccessToken.mockResolvedValue(null);

    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const response = await agent.fetch("http://api.test/messages?format=agui", { method: "POST" });

    // Returning the 401 lets HttpAgent surface it as a run failure; a blind
    // retry with no new token would just repeat it.
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-401 failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const response = await agent.fetch("http://api.test/messages?format=agui", { method: "POST" });

    expect(response.status).toBe(500);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });
});

describe("DeepAgentsBrowserAgent.connectAgent", () => {
  const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
  const sse = (events: Array<Record<string, unknown>>) => new Response(events.map(frame).join(""), {
    status: 200, headers: { "Content-Type": "text/event-stream" }
  });
  const history = [
    { type: EventType.RUN_STARTED, threadId: "s-1", runId: "history:1" },
    { type: EventType.MESSAGES_SNAPSHOT, messages: [{ id: "saved", role: "user", content: "earlier" }] },
    { type: EventType.STATE_SNAPSHOT, snapshot: { plan: "- step" } },
    { type: EventType.CUSTOM, name: "session_connection", value: { activeTurn: "attached", hasMoreHistory: false } },
    { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "history:1" }
  ];

  /** A connect response that stays open until the request aborts. */
  function openResponse(signal: AbortSignal | undefined): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(history.map(frame).join("")));
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("loads the history and then the running turn through GET /connect", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([
      ...history,
      { type: EventType.RUN_STARTED, threadId: "s-1", runId: "turn-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "reply-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply-1", delta: "live reply" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "reply-1" },
      { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "turn-1" }
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });

    const onRunInitialized = vi.fn(({ input }) => { expect(isReconnectRun(input)).toBe(true); });
    await agent.connectAgent(undefined, { onRunInitialized });

    expect(onRunInitialized).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api.test/sessions/s-1/connect");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(agent.messages).toMatchObject([
      { id: "saved", role: "user", content: "earlier" },
      { id: "reply-1", role: "assistant", content: "live reply" }
    ]);
    expect(agent.state).toEqual({ plan: "- step" });
  });

  it("closes the connection when its caller aborts, not when a later run replaces the controller", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return openResponse(init.signal ?? undefined);
    }));
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const caller = new AbortController();
    agent.abortController = caller;
    const onRunFinalized = vi.fn();
    const done = agent.connectAgent(undefined, { onRunFinalized });
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    // A message run sets its own controller. Aborting that one must not close
    // the connection that the caller still owns.
    agent.abortController = new AbortController();
    agent.abortController.abort();
    expect(signals[0]!.aborted).toBe(false);

    caller.abort();
    await done;
    expect(signals[0]!.aborted).toBe(true);
    expect(onRunFinalized).toHaveBeenCalledOnce();
    expect(agent.isClosedByClient(onRunFinalized.mock.calls[0]![0].input)).toBe(true);
  });

  it("closes the older connection when a newer one starts, and reports it as closed by this tab", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return openResponse(init.signal ?? undefined);
    }));
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const finalized: RunAgentInput[] = [];
    const first = agent.connectAgent(undefined, { onRunFinalized: ({ input }) => { finalized.push(input); } });
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    const second = agent.connectAgent(undefined, { onRunFinalized: ({ input }) => { finalized.push(input); } });
    await first;
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(agent.isClosedByClient(finalized[0]!)).toBe(true);
    agent.abortRun();
    await second;
    expect(signals[1]!.aborted).toBe(true);
    expect(agent.isClosedByClient(finalized[1]!)).toBe(true);
  });

  it("does not report a connection that the server ended as closed by this tab", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(history)));
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const onRunFinalized = vi.fn();
    await agent.connectAgent(undefined, { onRunFinalized });

    expect(agent.isClosedByClient(onRunFinalized.mock.calls[0]![0].input)).toBe(false);
  });

  it("closes the connection fetch when CopilotKit detaches the run", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return openResponse(init.signal ?? undefined);
    }));
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const done = agent.connectAgent();
    await vi.waitFor(() => expect(agent.messages).toHaveLength(1));

    await agent.detachActiveRun();
    await done;

    expect(signals[0]!.aborted).toBe(true);
  });

  it("does not fetch for a connection whose caller aborted before it started", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.abortController.abort();

    await agent.connectAgent();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isSessionBusyError", () => {
  function httpError(status: number, payload: unknown): Error {
    // The shape @ag-ui/client's runHttpRequest throws for a non-OK response.
    return Object.assign(new Error(`HTTP ${status}`), { status, payload });
  }

  it("matches the busy response of the message route and of a project lease", () => {
    expect(isSessionBusyError(httpError(429, { error: "session_busy" }))).toBe(true);
    expect(isSessionBusyError(httpError(409, { error: "session_busy" }))).toBe(true);
  });

  it("does not match rate limits, other codes, or plain errors", () => {
    expect(isSessionBusyError(httpError(429, { error: "rate_limited" }))).toBe(false);
    expect(isSessionBusyError(httpError(429, "session_busy"))).toBe(false);
    expect(isSessionBusyError(httpError(500, { error: "session_busy" }))).toBe(false);
    expect(isSessionBusyError(new Error("session_busy"))).toBe(false);
    expect(isSessionBusyError({ status: 429, payload: { error: "session_busy" } })).toBe(false);
  });
});

// The browser agent keeps the transcript equal to the saved history through
// @ag-ui/client 1.0's real reducer. Each connection is one SSE response.
describe("DeepAgentsBrowserAgent transcript", () => {
  const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
  const sse = (events: Array<Record<string, unknown>>) => new Response(events.map(frame).join(""), {
    status: 200, headers: { "Content-Type": "text/event-stream" }
  });
  const historyRun = (messages: object[], activeTurn: "none" | "attached" | "unavailable") => [
    { type: EventType.RUN_STARTED, threadId: "s-1", runId: "history:1" },
    { type: EventType.MESSAGES_SNAPSHOT, messages },
    { type: EventType.STATE_SNAPSHOT, snapshot: { plan: "" } },
    { type: EventType.CUSTOM, name: "session_connection", value: { activeTurn, hasMoreHistory: false } },
    { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "history:1" }
  ];
  /** Answers each connect with the next body. `fail` drops the stream after its events. */
  function stubConnections(...bodies: Array<{ events: object[]; fail?: boolean }>) {
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const body = bodies.shift()!;
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        // An error discards queued chunks, so the network fails on the read after the events.
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoder.encode(body.events.map((event) => frame(event as Record<string, unknown>)).join("")));
          } else if (body.fail) controller.error(new TypeError("network error"));
          else controller.close();
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));
  }
  const ids = (agent: DeepAgentsBrowserAgent) => agent.messages.map((message) => message.id);

  const USER = { id: "u1", role: "user", content: "Plan the migration" };
  const call = (id: string, toolCallId: string) =>
    ({ id, role: "assistant", toolCalls: [{ id: toolCallId, type: "function", function: { name: "list_files", arguments: "{}" } }] });
  const result = (toolCallId: string) => ({ id: `${toolCallId}:result`, role: "tool", toolCallId, content: "a.ts" });

  it("restores the final order after an unavailable partial reply grows", async () => {
    // The saved partial reply, while the turn ran without a replay.
    const partial = [
      USER,
      { id: "a1:text:0", role: "assistant", content: "First I look. " },
      call("a1:call:0", "tc-1"), result("tc-1"),
      { id: "a1:text:tail", role: "assistant", content: "Now I check" }
    ];
    // The final reply: the old tail is now a middle part.
    const final = [
      USER,
      { id: "a1:text:0", role: "assistant", content: "First I look. " },
      call("a1:call:0", "tc-1"), result("tc-1"),
      { id: "a1:text:14", role: "assistant", content: "Now I check. " },
      call("a1:call:1", "tc-2"), result("tc-2"),
      { id: "a1:text:tail", role: "assistant", content: "Done." }
    ];
    stubConnections({ events: historyRun(partial, "unavailable") }, { events: historyRun(final, "none") });
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });

    await agent.connectAgent();
    expect(ids(agent)).toEqual(partial.map((message) => message.id));
    await agent.connectAgent();

    expect(ids(agent)).toEqual(final.map((message) => message.id));
    expect(agent.messages.at(-1)).toMatchObject({ content: "Done." });
  });

  it("shows replayed reasoning once after the stream of its turn drops", async () => {
    const replay = [
      { type: EventType.RUN_STARTED, threadId: "s-1", runId: "turn-1" },
      { type: EventType.REASONING_MESSAGE_START, messageId: "r-1", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r-1", delta: "Weighing options" }
    ];
    stubConnections(
      { events: [...historyRun([USER], "attached"), ...replay], fail: true },
      {
        events: [
          ...historyRun([USER], "attached"), ...replay,
          { type: EventType.REASONING_MESSAGE_END, messageId: "r-1" },
          { type: EventType.TEXT_MESSAGE_START, messageId: "t-1", role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "t-1", delta: "Done." },
          { type: EventType.TEXT_MESSAGE_END, messageId: "t-1" },
          { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "turn-1" }
        ]
      }
    );
    // @ag-ui/client logs the rethrown network error of the first connection.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });

    await agent.connectAgent().catch(() => undefined);
    expect(agent.messages).toMatchObject([USER, { id: "r-1", content: "Weighing options" }]);
    await agent.connectAgent();

    expect(agent.messages).toEqual([
      USER,
      { id: "r-1", role: "reasoning", content: "Weighing options" },
      { id: "t-1", role: "assistant", content: "Done." }
    ]);
  });

  it("adds a saved prompt that the history of a connection lacks, once", async () => {
    const persisted = { type: EventType.CUSTOM, name: "user_message_persisted", value: { messageId: "u2", text: "Second question" } };
    stubConnections({
      events: [
        ...historyRun([USER], "attached"),
        { type: EventType.RUN_STARTED, threadId: "s-1", runId: "turn-1" },
        persisted, persisted,
        { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "turn-1" }
      ]
    });
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });

    await agent.connectAgent();

    expect(agent.messages).toEqual([USER, { id: "u2", role: "user", content: "Second question" }]);
  });

  it("does not add the saved prompt to the stream of the tab that sent it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([
      { type: EventType.RUN_STARTED, threadId: "s-1", runId: "turn-1" },
      { type: EventType.CUSTOM, name: "user_message_persisted", value: { messageId: "server-id", text: "Question" } },
      { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "turn-1" }
    ])));
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([{ id: "optimistic", role: "user", content: "Question" }]);

    await agent.runAgent();

    expect(ids(agent)).toEqual(["optimistic"]);
  });

  it.each([
    ["already holds the replaced text", [{ id: "u1", role: "user" as const, content: "already [REDACTED]" }], "already [REDACTED]"],
    ["has no user message", [{ id: "a1", role: "assistant" as const, content: "hi" }], "whatever"]
  ])("keeps the transcript when it %s", async (_, messages, text) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([
      { type: EventType.RUN_STARTED, threadId: "s-1", runId: "turn-1" },
      { type: EventType.CUSTOM, name: "user_message_replaced", value: { messageId: "x", text } },
      { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "turn-1" }
    ])));
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages(messages);

    await agent.runAgent();

    expect(agent.messages).toEqual(messages);
  });
});
