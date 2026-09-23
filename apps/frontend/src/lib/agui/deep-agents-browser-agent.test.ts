// @vitest-environment jsdom
import { EventType, type RunAgentInput } from "@ag-ui/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const refreshAccessToken = vi.hoisted(() => vi.fn());
vi.mock("../api-client", () => ({
  API_URL: "http://api.test",
  // Pass headers through untouched; what matters here is that the agent's fetch
  // goes through the app's header builder at all, not what it adds.
  createApiHeaders: (init?: HeadersInit) => new Headers(init),
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
    refreshAccessToken.mockResolvedValue("tok-2");

    const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
    const response = await agent.fetch("http://api.test/messages?format=agui", { method: "POST" });

    expect(response.status).toBe(200);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
  const frame = (event: Record<string, unknown>) => `id: 1\ndata: ${JSON.stringify(event)}\n\n`;

  it("attaches through GET and applies replayed events to the existing transcript", async () => {
    const events = [
      { type: EventType.RUN_STARTED, threadId: "s-1", runId: "turn-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "reply-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply-1", delta: "live reply" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "reply-1" },
      { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "turn-1" }
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(events.map(frame).join(""), {
      status: 200, headers: { "Content-Type": "text/event-stream" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({
      sessionId: "s-1",
      initialMessages: [{ id: "saved", role: "user", content: "earlier" }]
    });

    const onRunInitialized = vi.fn(({ input }) => { expect(isReconnectRun(input)).toBe(true); });
    await agent.connectAgent(undefined, { onRunInitialized });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRunInitialized).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api.test/sessions/s-1/events?after=0");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(agent.messages).toMatchObject([
      { id: "saved", role: "user", content: "earlier" },
      { id: "reply-1", role: "assistant", content: "live reply" }
    ]);
  });

  it.each([
    [204, ""],
    [409, JSON.stringify({ error: "replay_gap" })]
  ])("finishes without changing history when replay cannot attach (%i)", async (status, body) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body || null, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new DeepAgentsBrowserAgent({
      sessionId: "s-1",
      initialMessages: [{ id: "saved", role: "user", content: "earlier" }]
    });
    const onRunFinalized = vi.fn();

    await agent.connectAgent(undefined, { onRunFinalized });

    expect(onRunFinalized).toHaveBeenCalledOnce();
    expect(agent.messages).toEqual([{ id: "saved", role: "user", content: "earlier" }]);
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
