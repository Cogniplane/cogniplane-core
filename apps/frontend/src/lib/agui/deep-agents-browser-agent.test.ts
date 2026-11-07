// @vitest-environment jsdom

import { A2UI_VERSION } from "@copilotkit/shared";
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

import { GENERATIVE_UI_CATALOG_ID, GENERATIVE_UI_PANEL_TARGET, MAX_GENERATIVE_UI_CONTEXT_LENGTH } from "@cogniplane/shared-types";

import {
  AgentCopyRefusedError,
  composeGenerativeUiContext,
  DeepAgentsBrowserAgent,
  EARLIER_RECORDS_HEADING,
  GenerativeUiActionBlockedError,
  GenerativeUiContextTooLargeError,
  GenerativeUiRecordsWithheldError,
  httpFailure,
  isGenerativeUiActionBlocked,
  isReconnectRun,
  isSessionBusyError,
  MAX_EARLIER_VALUE_CHARS,
  previewEarlierRecords
} from "./deep-agents-browser-agent";
import { PARKED_PANEL_TARGET } from "./generative-ui-targets";
import { refusedSendNotice } from "./use-session-connection";

// requestInit is protected; the subclass only widens visibility.
class ProbeAgent extends DeepAgentsBrowserAgent {
  buildRequestInit(input: RunAgentInput): RequestInit {
    return this.requestInit(input);
  }
  connectDirect(input: RunAgentInput) {
    return this.connect(input);
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

// The two context entries of CopilotKit's markdown transport, as CopilotKit names them.
const GUIDE = "Generative UI markdown guide: how to write UI surfaces inside ```a2ui code fences in a normal markdown reply.";
const SCHEMA = "Generative UI component schema: the components, props, events, slots, functions, and targets that ```a2ui code fences can use, and the surfaces that already exist.";

describe("DeepAgentsBrowserAgent generative-UI context on the wire", () => {
  const withContext = (context: Array<{ description: string; value: string }>, extra: Record<string, unknown> = {}) =>
    ({ ...runInput([{ role: "user", content: "hi" }]), context, ...extra }) as unknown as RunAgentInput;

  it("sends the two entries, each after its description, and nothing else of what CopilotKit hands over", () => {
    const agent = new ProbeAgent({ sessionId: "s-1" });

    const init = agent.buildRequestInit(withContext(
      [
        { description: "The page the user looks at", value: "PRIVATE-PAGE-CONTEXT" },
        // CopilotKit lists the schema first here. The body puts the guide first, always.
        { description: SCHEMA, value: "{\"components\":{}}" },
        { description: GUIDE, value: "RULES" },
        { description: "Another entry with a similar description. Generative UI", value: "PRIVATE-OTHER" }
      ],
      {
        tools: [{ name: "private_tool", description: "x", parameters: {} }],
        forwardedProps: { copilotkit: { ui: { v: "PRIVATE-ENVELOPE" } }, command: { resume: "PRIVATE-RESUME" } },
        state: { secret: "PRIVATE-STATE" }
      }
    ));

    expect(bodyOf(init)).toEqual({
      sessionId: "s-1",
      text: "hi",
      generativeUiContext: `${GUIDE}\nRULES\n\n${SCHEMA}\n{"components":{}}`
    });
    expect(init.body).not.toMatch(/PRIVATE|private_tool/);
  });

  const CHAT_TARGET = { id: "chat", kind: "chat" };
  const envelope = (description = "Text component", targets: object[] = [CHAT_TARGET]) => ({ copilotkit: { ui: {
    [A2UI_VERSION]: { supportedCatalogIds: [GENERATIVE_UI_CATALOG_ID], inlineCatalogs: [{
      catalogId: GENERATIVE_UI_CATALOG_ID, protocolVersion: "1.0", functions: {},
      components: { Text: { description, props: { type: "object", properties: { text: { type: "string" } } } } }
    }] },
    metadata: { extensions: { copilotkit_format: 3, copilotkit_transport: "markdown", copilotkit_contextSent: false,
      copilotkit_targets: targets, copilotkit_surfaces: {} as Record<string, object> } }
  } } });

  it("builds the tool guide from a valid catalog envelope without forwarding unrelated run data", () => {
    const agent = new ProbeAgent({ sessionId: "s-1" });
    const init = agent.buildRequestInit(withContext([{ description: GUIDE, value: "OLD MARKDOWN GUIDE" }], {
      forwardedProps: { ...envelope(), unrelated: "PRIVATE-EXTRA" },
      tools: [{ name: "private_tool", parameters: {} }], state: { private: "PRIVATE-STATE" }
    }));
    expect(bodyOf(init)).toEqual({ sessionId: "s-1", text: "hi", generativeUiTransport: "tool",
      generativeUiContext: expect.stringContaining("how to call render_ui") });
    expect(init.body).toContain("Text component");
    expect(init.body).not.toMatch(/PRIVATE|private_tool|OLD MARKDOWN/);
  });

  it("refuses an oversized guide from a valid envelope before fetching", () => {
    const agent = new ProbeAgent({ sessionId: "s-1" });
    expect(() => agent.buildRequestInit(withContext([], {
      forwardedProps: envelope("x".repeat(MAX_GENERATIVE_UI_CONTEXT_LENGTH))
    }))).toThrow(GenerativeUiContextTooLargeError);
  });

  it("keeps previous user values as read-only data outside the SDK's editable surface list", () => {
    const forwardedProps = envelope();
    Object.assign(forwardedProps.copilotkit.ui.metadata.extensions.copilotkit_surfaces, {
      "turn:a1:seats": { target: "chat", dataModel: { seats: "USER-ENTERED-7" }, rejected: ["operation 2: unknown component"] }
    });
    const context = String(bodyOf(new ProbeAgent({ sessionId: "s-1" }).buildRequestInit(withContext([], { forwardedProps }))).generativeUiContext);
    const [guide, previous] = context.split(EARLIER_RECORDS_HEADING);
    expect(guide).toContain("### Existing surfaces\n- none");
    expect(guide).not.toMatch(/turn:a1:seats|USER-ENTERED-7/);
    expect(previous).toContain("not editable surfaces");
    expect(previous).toContain("USER-ENTERED-7");
    expect(previous).toContain("unknown component");
  });

  it("tells the model that an earlier view is read-only but its values are current and readable", () => {
    const context = contextOf(withSurfaces({
      "turn:a1:seats": { target: "chat", dataModel: { "/note": "NOTE-ENTERED-IN-UI", "/done": false } }
    }));
    const [guide, rest] = context.split(EARLIER_RECORDS_HEADING) as [string, string];
    const intro = rest.slice(0, rest.indexOf("\n{"));
    const rules = rest.slice(rest.lastIndexOf("\n\nRender only to"));

    // The heading names the user's entries, not "context from earlier replies".
    expect(EARLIER_RECORDS_HEADING).not.toMatch(/context|old|stale/i);
    // The editing limit is about the view. It does not call the values old.
    expect(intro).toContain("so you cannot edit the view");
    expect(intro).toContain("The view is from an earlier reply, but its values are current.");
    expect(intro).toContain("as the browser has it for this request");
    expect(intro).toContain("Read these values and use them.");
    expect(intro).toContain("The user can change these values between requests and after this request is sent.");
    expect(intro).toContain("A value that differs from an earlier request is an edit. It does not show that an earlier answer was wrong.");
    expect(intro).toContain("The records do not show when or why a value changed.");
    expect(rules).toContain("You cannot change surfaces from earlier replies.");
    // The model may not fill a gap with a guess, and no text claims that the list is complete.
    expect(intro).toContain("Only values that the user set are listed. If a path is not listed, do not assume a value for it.");
    expect(intro).not.toMatch(/\ball\b|every|complete/i);
    // The values reach the model as sent: text and false included.
    expect(rest).toContain('"userValues":{"/note":"NOTE-ENTERED-IN-UI","/done":false}');
    expect(guide).not.toContain("NOTE-ENTERED-IN-UI");
  });

  const contextOf = (forwardedProps: object) =>
    String(bodyOf(new ProbeAgent({ sessionId: "s-1" }).buildRequestInit(withContext([], { forwardedProps }))).generativeUiContext);
  const withSurfaces = (surfaces: Record<string, object>) => {
    const forwardedProps = envelope();
    Object.assign(forwardedProps.copilotkit.ui.metadata.extensions.copilotkit_surfaces, surfaces);
    return forwardedProps;
  };
  it("does not refer to user entries when the request has none", () => {
    const context = contextOf(withSurfaces({}));
    expect(context).not.toContain(EARLIER_RECORDS_HEADING);
    expect(context).not.toContain("listed above");
    expect(context).toContain("You cannot change surfaces from earlier replies.");
  });
  /** The read-only section of a guide, and its records parsed as JSON. */
  const earlierSection = (context: string) => {
    const section = context.slice(context.indexOf(`\n\n${EARLIER_RECORDS_HEADING}`), context.lastIndexOf("\n\nRender only to"));
    const records = section.split("\n").filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { source: string; userValues?: Record<string, unknown>; cutValues?: string[]; omittedValues?: string[] });
    return { section, records };
  };

  it("sends a value that follows a long text, and every record is valid JSON", () => {
    const description = "d".repeat(501);
    const { records } = earlierSection(contextOf(withSurfaces({
      "turn:a1:form": { target: "chat", dataModel: { "/description": description, "/answer": "USER-ANSWER-42" } }
    })));
    expect(records).toEqual([{ source: "turn:a1:form", target: "chat", userValues: { "/description": description, "/answer": "USER-ANSWER-42" } }]);
  });

  it("cuts only a text longer than the value limit, names it, and leaves out a large structured value by name", () => {
    const context = contextOf(withSurfaces({
      "turn:a1:notes": { target: "chat", dataModel: {
        "/notes": `${"n".repeat(4_000)}CUT-TAIL`,
        "/after": "AFTER-LONG-TEXT",
        "/choices": ["red", "blue"],
        "/table": { rows: "x".repeat(5_000) }
      } }
    }));
    const { section, records } = earlierSection(context);
    expect(section).toContain("cutValues holds only the first 4000 characters");
    expect(records).toEqual([{ source: "turn:a1:notes", target: "chat",
      userValues: { "/notes": "n".repeat(4_000), "/after": "AFTER-LONG-TEXT", "/choices": ["red", "blue"] },
      cutValues: ["/notes"], omittedValues: ["/table"] }]);
    expect(context).not.toMatch(/CUT-TAIL|xxxxx/);
  });

  it("sends the newest earlier records that fit their budget, and counts the records that it leaves out", () => {
    const surfaces = Object.fromEntries(Array.from({ length: 20 }, (_, index) =>
      [`turn:a${index}:form`, { target: "chat", dataModel: { "/text": `VALUE-${index}-${"v".repeat(3_900)}` } }]));
    const context = contextOf(withSurfaces(surfaces));
    const { section, records } = earlierSection(context);
    const sent = records.map((record) => record.source);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(20);
    // The newest records, in their order.
    expect(sent).toEqual(Array.from({ length: sent.length }, (_, index) => `turn:a${20 - sent.length + index}:form`));
    expect(section).toContain(`Records left out to stay in the size limit: ${20 - sent.length}.`);
    expect(section.length).toBeLessThanOrEqual(32_000);
    expect(context).not.toContain("VALUE-0-");
  });

  it("offers the side panel only when it is mounted, and never another named target", () => {
    const guideOf = (forwardedProps: object) =>
      String(bodyOf(new ProbeAgent({ sessionId: "s-1" }).buildRequestInit(withContext([], { forwardedProps }))).generativeUiContext);
    const chatOnly = guideOf(envelope());
    expect(chatOnly).toContain('- "chat" (inside the chat transcript)');
    expect(chatOnly).toContain('Render only to "chat".');
    expect(chatOnly).not.toContain(GENERATIVE_UI_PANEL_TARGET);

    const forwardedProps = envelope("Text component", [
      CHAT_TARGET,
      { id: GENERATIVE_UI_PANEL_TARGET, kind: "inline", description: "PANEL-DESCRIPTION" },
      { id: "checkout-banner", kind: "inline", description: "ROGUE-DESCRIPTION" }
    ]);
    Object.assign(forwardedProps.copilotkit.ui.metadata.extensions.copilotkit_surfaces, {
      "turn:a1:board": { target: GENERATIVE_UI_PANEL_TARGET, dataModel: { owner: "PANEL-VALUE" } },
      "turn:a1:banner": { target: "checkout-banner", dataModel: { secret: "ROGUE-VALUE" } }
    });
    const withPanel = guideOf(forwardedProps);
    expect(withPanel).toContain(`- "${GENERATIVE_UI_PANEL_TARGET}" (a named area of the app): PANEL-DESCRIPTION`);
    expect(withPanel).toContain(`Render only to "chat" or "${GENERATIVE_UI_PANEL_TARGET}".`);
    expect(withPanel).toContain("A surface keeps the target of its createSurface.");
    expect(withPanel).toContain(`"target":"${GENERATIVE_UI_PANEL_TARGET}"`);
    expect(withPanel).toContain("PANEL-VALUE");
    expect(withPanel).not.toMatch(/checkout-banner|ROGUE/);
  });

  it("sends the last entry of a description, skips an empty one, and leaves the field out without entries", () => {
    expect(composeGenerativeUiContext([
      { description: GUIDE, value: "old" },
      { description: GUIDE, value: "new" },
      { description: SCHEMA, value: "  " }
    ])).toBe(`${GUIDE}\nnew`);
    expect(composeGenerativeUiContext([{ description: SCHEMA, value: "{}" }])).toBe(`${SCHEMA}\n{}`);
    expect(composeGenerativeUiContext([])).toBeUndefined();
    expect(composeGenerativeUiContext(undefined)).toBeUndefined();
    const agent = new ProbeAgent({ sessionId: "s-1" });
    expect(bodyOf(agent.buildRequestInit(withContext([{ description: "Other", value: "x" }])))).toEqual({ sessionId: "s-1", text: "hi" });
  });

  it("accepts a context of exactly the limit and refuses one character more, as a refused send", () => {
    const fill = (length: number) => [{ description: GUIDE, value: "x".repeat(length - GUIDE.length - 1) }];
    expect(composeGenerativeUiContext(fill(MAX_GENERATIVE_UI_CONTEXT_LENGTH))).toHaveLength(MAX_GENERATIVE_UI_CONTEXT_LENGTH);
    const agent = new ProbeAgent({ sessionId: "s-1" });

    let error: unknown;
    try {
      agent.buildRequestInit(withContext(fill(MAX_GENERATIVE_UI_CONTEXT_LENGTH + 1)));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GenerativeUiContextTooLargeError);
    expect((error as Error).message).toContain(`${MAX_GENERATIVE_UI_CONTEXT_LENGTH + 1} characters`);
    expect((error as Error).message).toContain(`limit is ${MAX_GENERATIVE_UI_CONTEXT_LENGTH}`);
    // It has the shape of an HTTP refusal, so the session connection removes the unsent message and shows this text.
    expect(httpFailure(error)).toEqual({
      status: 413,
      body: { error: "generative_ui_context_too_large", message: (error as Error).message }
    });
    expect(refusedSendNotice(error)).toMatchObject({ level: "error", title: "Your message was not sent", message: (error as Error).message });
  });
});

describe("DeepAgentsBrowserAgent after a PII refusal of earlier UI records", () => {
  const BACKEND_MESSAGE = "Interactive UI context was blocked by organization policy.";
  const refusal = (error = "generative_ui_context_blocked") => new Response(
    JSON.stringify({ error, message: BACKEND_MESSAGE }),
    { status: 422, headers: { "Content-Type": "application/json" } }
  );
  const runFinished = () => new Response(
    [
      { type: EventType.RUN_STARTED, threadId: "s-1", runId: "r-1" },
      { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "r-1" }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  const envelope = (surfaces: Record<string, object>) => ({ copilotkit: { ui: {
    [A2UI_VERSION]: { supportedCatalogIds: [GENERATIVE_UI_CATALOG_ID], inlineCatalogs: [{
      catalogId: GENERATIVE_UI_CATALOG_ID, protocolVersion: "1.0", functions: {}, components: {}
    }] },
    metadata: { extensions: { copilotkit_format: 3, copilotkit_transport: "markdown", copilotkit_contextSent: false,
      copilotkit_targets: [{ id: "chat", kind: "chat" }, { id: GENERATIVE_UI_PANEL_TARGET, kind: "inline" }],
      copilotkit_surfaces: surfaces } }
  } } });
  const contextOf = (call: unknown) => String(bodyOf((call as [string, RequestInit])[1]).generativeUiContext);
  const send = async (agent: DeepAgentsBrowserAgent, surfaces: Record<string, object>) =>
    agent.runAgent({ forwardedProps: envelope(surfaces) }).then(() => undefined, (error: unknown) => error);

  // The panel shows one view at a time, so the user may not see the older one.
  const HIDDEN_PANEL = { target: GENERATIVE_UI_PANEL_TARGET, dataModel: { "/ssn": "123-45-6789" } };
  const NEWEST_PANEL = { target: GENERATIVE_UI_PANEL_TARGET, dataModel: { "/name": "Ada" } };
  const CHAT_POLL = { target: "chat", rejected: ["operation 1: unknown component"] };

  it("leaves out the blocked records of a hidden panel view, tells the user to send again, and sends changed values", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal()).mockImplementation(async () => runFinished());
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([{ id: "u1", role: "user", content: "Next question" }]);
    const surfaces = { "turn:a1:old": HIDDEN_PANEL, "turn:a2:new": NEWEST_PANEL, "turn:a2:poll": CHAT_POLL };

    const error = await send(agent, surfaces);

    expect(contextOf(fetchMock.mock.calls[0])).toContain("123-45-6789");
    expect(error).toBeInstanceOf(GenerativeUiRecordsWithheldError);
    // The session connection shows this message, and removes the message that was not sent.
    expect(httpFailure(error)).toEqual({ status: 422, body: { error: "generative_ui_context_blocked", message: (error as Error).message } });
    expect(refusedSendNotice(error)).toMatchObject({ title: "Your message was not sent", message: expect.stringContaining("Send your message again") });

    expect(await send(agent, surfaces)).toBeUndefined();
    const retry = contextOf(fetchMock.mock.calls[1]);
    expect(retry).not.toMatch(/123-45-6789|Ada|unknown component/);
    expect(retry).toContain("Records left out because organization policy blocked them: 3.");
    expect(bodyOf((fetchMock.mock.calls[1] as [string, RequestInit])[1])).toMatchObject({ text: "Next question", generativeUiTransport: "tool" });

    // A value that the user changes is new data.
    expect(await send(agent, { ...surfaces, "turn:a2:new": { ...NEWEST_PANEL, dataModel: { "/name": "Grace" } } })).toBeUndefined();
    const changed = contextOf(fetchMock.mock.calls[2]);
    expect(changed).toContain('"userValues":{"/name":"Grace"}');
    expect(changed).not.toContain("123-45-6789");
    expect(changed).toContain("Records left out because organization policy blocked them: 2.");
  });

  it("previews the records that the next message sends, the blocked ones left out", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal()).mockImplementation(async () => runFinished());
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([{ id: "u1", role: "user", content: "Next question" }]);
    const surfaces = { "turn:a1:old": HIDDEN_PANEL, "turn:a2:new": NEWEST_PANEL };
    expect(agent.previewEarlierRecords(surfaces)).toEqual({ records: [
      { source: "turn:a1:old", target: GENERATIVE_UI_PANEL_TARGET, userValues: { "/ssn": "123-45-6789" } },
      { source: "turn:a2:new", target: GENERATIVE_UI_PANEL_TARGET, userValues: { "/name": "Ada" } }
    ], tooLarge: 0, blocked: 0 });

    await send(agent, surfaces);
    expect(agent.previewEarlierRecords(surfaces)).toEqual({ records: [], tooLarge: 0, blocked: 2 });
    const changed = { ...surfaces, "turn:a2:new": { ...NEWEST_PANEL, dataModel: { "/name": "Grace" } } };
    expect(agent.previewEarlierRecords(changed).records).toEqual([
      { source: "turn:a2:new", target: GENERATIVE_UI_PANEL_TARGET, userValues: { "/name": "Grace" } }
    ]);
  });

  it("reads a panel view that the panel parked as a panel view, in the preview and in the request", async () => {
    const parked = { target: PARKED_PANEL_TARGET, dataModel: { "/note": "Typed in the earlier view" } };
    const stray = { target: `${GENERATIVE_UI_PANEL_TARGET}:other`, dataModel: { "/note": "A target that nobody mounts" } };
    const surfaces = { "turn:a1:old": parked, "turn:a2:new": NEWEST_PANEL, "turn:a2:stray": stray };
    expect(previewEarlierRecords(surfaces as never).records).toEqual([
      { source: "turn:a1:old", target: GENERATIVE_UI_PANEL_TARGET, userValues: { "/note": "Typed in the earlier view" } },
      { source: "turn:a2:new", target: GENERATIVE_UI_PANEL_TARGET, userValues: { "/name": "Ada" } }
    ]);

    const fetchMock = vi.fn().mockImplementation(async () => runFinished());
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([{ id: "u1", role: "user", content: "Next question" }]);
    await send(agent, surfaces);
    const context = contextOf(fetchMock.mock.calls[0]);
    // The model reads the target that it gave the view, never the host's own.
    expect(context).toContain('"source":"turn:a1:old","target":"side-panel"');
    expect(context).not.toContain(PARKED_PANEL_TARGET);
    expect(context).not.toContain("A target that nobody mounts");
  });

  it("previews a cut text and a value too large to send as the request sends them", () => {
    const long = `${"a".repeat(MAX_EARLIER_VALUE_CHARS)}TAIL`;
    const big = Array.from({ length: 2_000 }, (_, index) => index);
    const preview = previewEarlierRecords({ "turn:a1:x": { target: "chat", dataModel: { "/notes": long, "/rows": big } } as never });
    expect(preview.records).toEqual([{ source: "turn:a1:x", target: "chat", userValues: { "/notes": "a".repeat(MAX_EARLIER_VALUE_CHARS) },
      cutValues: ["/notes"], omittedValues: ["/rows"] }]);
    // The newest records fill the budget. The rest are counted.
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
      [`turn:${index}`, { target: "chat", dataModel: { "/notes": "b".repeat(3_000) } }]));
    const counted = previewEarlierRecords(many as never);
    expect(counted.records.map((record) => record.source)).toEqual(Array.from({ length: 10 }, (_, index) => `turn:${index + 2}`));
    expect(counted.tooLarge).toBe(2);
  });

  it("keeps the backend refusal and every record when this tab has nothing to leave out", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(refusal("generative_ui_context_too_large"))
      .mockImplementation(async () => runFinished());
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([{ id: "u1", role: "user", content: "Next question" }]);

    // The blocked text is the guide itself, not a record.
    const noRecords = await send(agent, {});
    expect(noRecords).not.toBeInstanceOf(GenerativeUiRecordsWithheldError);
    expect(httpFailure(noRecords)).toEqual({ status: 422, body: { error: "generative_ui_context_blocked", message: BACKEND_MESSAGE } });

    // Another refusal code does not withhold the records.
    const otherCode = await send(agent, { "turn:a1:old": HIDDEN_PANEL });
    expect(httpFailure(otherCode)?.body.error).toBe("generative_ui_context_too_large");
    expect(await send(agent, { "turn:a1:old": HIDDEN_PANEL })).toBeUndefined();
    expect(contextOf(fetchMock.mock.calls[2])).toContain("123-45-6789");
  });
});

describe("DeepAgentsBrowserAgent refuses the runs that generated UI starts", () => {
  const ACTION = { copilotkit: { ui: { metadata: { extensions: { copilotkit_format: "a2ui", copilotkit_action: { name: "pick_plan" } } } } } };
  const runFinished = () => new Response(
    [
      { type: EventType.RUN_STARTED, threadId: "s-1", runId: "r-1" },
      { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "r-1" }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  const REAL = { id: "u0", role: "user" as const, content: "Earlier question" };
  const REPLY = { id: "a0", role: "assistant" as const, content: "Earlier answer" };
  const SYNTHETIC = { id: "synthetic", role: "user" as const, content: "I pick the Team plan" };
  const ids = (agent: DeepAgentsBrowserAgent) => agent.messages.map((message) => message.id);

  it.each([
    ["an action", { name: "pick_plan" }],
    ["an empty action", null]
  ])("refuses a run with %s, removes the last user message, and keeps the earlier ones", async (_, action) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([REAL, REPLY, SYNTHETIC]);

    const run = agent.runAgent({ forwardedProps: { copilotkit: { ui: { metadata: { extensions: { copilotkit_action: action } } } } } });

    await expect(run).rejects.toBeInstanceOf(GenerativeUiActionBlockedError);
    await run.catch((error: unknown) => expect(isGenerativeUiActionBlocked(error)).toBe(true));
    expect(ids(agent)).toEqual(["u0", "a0"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agent.isRunning).toBe(false);
  });

  it("removes only the last user message, even when the message before it is a user message", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([REAL, SYNTHETIC]);

    await expect(agent.runAgent({ forwardedProps: ACTION })).rejects.toBeInstanceOf(GenerativeUiActionBlockedError);

    expect(ids(agent)).toEqual(["u0"]);
  });

  it("removes no message when the last one is not a user message", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([REAL, REPLY]);

    await expect(agent.runAgent({ forwardedProps: ACTION })).rejects.toBeInstanceOf(GenerativeUiActionBlockedError);

    expect(ids(agent)).toEqual(["u0", "a0"]);
  });

  it("refuses the follow-up run that answers a function of the model, and keeps the answer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const answer = { id: "dev-1", role: "developer" as const, content: JSON.stringify({ version: A2UI_VERSION, rendererFunctionResponse: { functionCallId: "c1", error: { code: "x" } } }) };
    agent.setMessages([REAL, REPLY, answer]);

    await expect(agent.runAgent()).rejects.toBeInstanceOf(GenerativeUiActionBlockedError);

    expect(ids(agent)).toEqual(["u0", "a0", "dev-1"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends a normal message, with the model of the moment, after a refused run", async () => {
    const fetchMock = vi.fn(async () => runFinished());
    vi.stubGlobal("fetch", fetchMock);
    let model = "model-1";
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1", getModel: () => model });
    agent.setMessages([REAL, REPLY, SYNTHETIC]);
    await expect(agent.runAgent({ forwardedProps: ACTION })).rejects.toBeInstanceOf(GenerativeUiActionBlockedError);
    model = "model-2";
    agent.addMessage({ id: "u1", role: "user", content: "A real question" });

    // CopilotKit's run of a normal message carries forwarded props without an action.
    await agent.runAgent({ forwardedProps: { copilotkit: { ui: { metadata: { extensions: { copilotkit_format: "a2ui" } } } } } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string)).toEqual({
      sessionId: "s-1", text: "A real question", model: "model-2"
    });
  });

  it("does not close the connection of the session when it refuses a run", async () => {
    let connection: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      connection = init.signal ?? undefined;
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }));
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const connecting = agent.connectAgent().catch(() => undefined);
    await vi.waitFor(() => expect(connection).toBeDefined());
    agent.setMessages([REAL, REPLY, SYNTHETIC]);

    await expect(agent.runAgent({ forwardedProps: ACTION })).rejects.toBeInstanceOf(GenerativeUiActionBlockedError);

    expect(connection!.aborted).toBe(false);
    agent.abortRun();
    await connecting;
    expect(connection!.aborted).toBe(true);
  });
});

describe("DeepAgentsBrowserAgent.clone", () => {
  const REAL = { id: "u0", role: "user" as const, content: "Earlier question" };

  it("gives the copy no subscribers, so a change to the copy does not reach the chat", () => {
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.setMessages([REAL]);
    const seen = vi.fn();
    agent.subscribe({ onMessagesChanged: seen, onStateChanged: seen });
    const subscribers = agent.subscribers.length;

    const copy = agent.clone();
    copy.setMessages([]);
    copy.setState({ plan: "copy" });

    expect(copy).toBeInstanceOf(DeepAgentsBrowserAgent);
    expect(copy.subscribers).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
    expect(agent.subscribers).toHaveLength(subscribers);
    expect(agent.messages).toEqual([REAL]);
  });

  it("refuses to run, connect, or detach the copy before a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const copy = new DeepAgentsBrowserAgent({ sessionId: "s-1" }).clone();
    copy.addMessage({ id: "u1", role: "user", content: "From a copy" });

    await expect(copy.detachActiveRun()).rejects.toBeInstanceOf(AgentCopyRefusedError);
    await expect(copy.runAgent()).rejects.toBeInstanceOf(AgentCopyRefusedError);
    await expect(copy.connectAgent()).rejects.toBeInstanceOf(AgentCopyRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(copy.isRunning).toBe(false);
  });

  it.each([1, 2])("refuses direct request paths after %i copies", async (count) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let copy = new ProbeAgent({ sessionId: "s-1" });
    for (let index = 0; index < count; index += 1) copy = copy.clone() as ProbeAgent;
    copy.addMessage({ id: "copy-user", role: "user", content: "From a copy" });
    const input = runInput([{ role: "user", content: "From a copy" }]);
    const consume = (start: () => { subscribe(observer: { error: (error: unknown) => void; complete: () => void }): unknown }) =>
      new Promise<void>((resolve, reject) => { start().subscribe({ error: reject, complete: resolve }); });

    await expect(consume(() => copy.run(input))).rejects.toBeInstanceOf(AgentCopyRefusedError);
    await expect(consume(() => copy.legacy_to_be_removed_runAgentBridged())).rejects.toBeInstanceOf(AgentCopyRefusedError);
    expect(() => copy.connectDirect(input)).toThrow(AgentCopyRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the original agent able to send", async () => {
    const fetchMock = vi.fn(async () => new Response(
      [
        { type: EventType.RUN_STARTED, threadId: "s-1", runId: "r-1" },
        { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "r-1" }
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    agent.clone();
    agent.addMessage({ id: "u1", role: "user", content: "A real question" });

    await agent.runAgent();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string)).toEqual({
      sessionId: "s-1", text: "A real question"
    });
  });
});
