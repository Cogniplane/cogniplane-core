import { test, expect, vi } from "vitest";
import { EventType, verifyEvents, type BaseEvent } from "@ag-ui/client";
import { firstValueFrom, from as rxFrom, toArray } from "rxjs";

import { streamAssistantReplyAGUI, type StreamAssistantReplyAGUIInput } from "./sse-stream-writer-agui.js";
import { AGUI_INTERRUPTED_RESULT } from "./deep-agents/agui-events.js";
import { TurnEventLog } from "./turn-event-log.js";

// ---------------------------------------------------------------------------
// Minimal fakes — the writer only touches reply.raw, messages.{create,
// updateContent}, toolContexts.create, and runtimeAdapter.{createSession,
// runMessageAGUI}. Everything else on those types is unused here.
// ---------------------------------------------------------------------------

function makeRawResponse() {
  let writableEnded = false;
  const writes: string[] = [];
  return {
    writes,
    raw: {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      once() {},
      on() {},
      end() {
        writableEnded = true;
      },
      get writableEnded() {
        return writableEnded;
      },
      destroyed: false
    }
  };
}

function makeMessages() {
  const contentLog: Array<{ status: string; content: string }> = [];
  const streamingLog: Array<{
    reasoningContent?: string;
    reasoningSegments?: Array<{ offset: number; text: string }>;
    planContent?: string;
  }> = [];
  const toolResultLog: Array<Record<string, unknown>> = [];
  const noticeLog: unknown[][] = [];
  return {
    contentLog,
    streamingLog,
    toolResultLog,
    noticeLog,
    async create() {
      return { messageId: "msg-assistant", id: 42 };
    },
    async updateContent(_tid: string, _mid: string, _uid: string, status: string, content: string) {
      contentLog.push({ status, content });
    },
    async updateStreamingContent(
      _tid: string,
      _mid: string,
      _uid: string,
      content: {
        reasoningContent?: string;
        reasoningSegments?: Array<{ offset: number; text: string }>;
        planContent?: string;
      }
    ) {
      streamingLog.push(content);
    },
    async upsertToolResult(input: Record<string, unknown>) {
      toolResultLog.push(input);
      return input;
    },
    async setRuntimeNotices(_tid: string, _mid: string, _uid: string, notices: unknown[]) {
      noticeLog.push([...notices]);
    },
    async deleteToolResult() {
      return;
    }
  };
}

function makeToolContexts() {
  return {
    async create() {
      return { toolContextId: "ctx-1" };
    }
  };
}

function makeAdapter(events: BaseEvent[], runInputs: Array<{ turnContext?: string }>) {
  return {
    async createSession() {
      return { sessionId: "session-1", runtimeId: "runtime-1", runtimePolicy: { id: "default" } };
    },
    async *runMessageAGUI(_session: unknown, input: { turnContext?: string }) {
      runInputs.push(input);
      for (const event of events) yield event;
    }
  };
}

function runInput(events: BaseEvent[], extra: Partial<StreamAssistantReplyAGUIInput> = {}) {
  const reply = makeRawResponse();
  const messages = makeMessages();
  const runInputs: Array<{ turnContext?: string }> = [];
  const input = {
    reply: reply as unknown,
    messages,
    toolContexts: makeToolContexts(),
    runtimeAdapter: makeAdapter(events, runInputs),
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    modelName: "zai/glm-4.7",
    prompt: "hi",
    ...extra
  } as unknown as StreamAssistantReplyAGUIInput;
  return { input, messages, reply, runInputs };
}

test("persists a completed turn with the streamed assistant text", async () => {
  const { input, messages } = runInput([
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hello" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
  ]);

  await streamAssistantReplyAGUI(input);

  expect(messages.contentLog.at(-1)).toEqual({ status: "completed", content: "hello" });
});

test("a closed stream still completes the turn and saves its tool result", async () => {
  const eventLog = new TurnEventLog();
  const received: BaseEvent[] = [];
  eventLog.subscribe(0, (entry) => { if (entry) received.push(entry.event); });
  const { input, messages, reply } = runInput([
    { type: EventType.RUN_STARTED, threadId: "session-1", runId: "run-1" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "done" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "m" } as BaseEvent,
    { type: EventType.TOOL_CALL_START, toolCallId: "tool-1", toolCallName: "execute" } as BaseEvent,
    { type: EventType.TOOL_CALL_RESULT, toolCallId: "tool-1", content: "ok" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "run-1" } as BaseEvent
  ], { eventLog });
  reply.raw.destroyed = true;

  await streamAssistantReplyAGUI(input);

  expect(messages.contentLog.at(-1)).toEqual({ status: "completed", content: "done" });
  expect(messages.toolResultLog.at(-1)).toMatchObject({ toolResultId: "tool-1", status: "completed", output: "ok" });
  expect(reply.writes).toEqual([]);
  expect(received.map((event) => event.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.CUSTOM,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_RESULT,
    EventType.RUN_FINISHED
  ]);
  expect(eventLog.subscribe(0, () => undefined)).toBeNull();
});

test("replay includes the saved user prompt before the assistant reply", async () => {
  const eventLog = new TurnEventLog();
  const received: BaseEvent[] = [];
  eventLog.subscribe(0, (entry) => { if (entry) received.push(entry.event); });
  const { input } = runInput([
    { type: EventType.RUN_STARTED, threadId: "session-1", runId: "run-1" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "Hello" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "run-1" } as BaseEvent
  ], { eventLog, persistedUserMessage: { messageId: "question", text: "What happened?" } });

  await streamAssistantReplyAGUI(input);

  expect(received[0]?.type).toBe(EventType.RUN_STARTED);
  const promptIndex = received.findIndex((event) => event.type === EventType.CUSTOM && event.name === "user_message_persisted");
  const replyIndex = received.findIndex((event) => event.type === EventType.TEXT_MESSAGE_START);
  expect(promptIndex).toBeGreaterThan(0);
  expect(promptIndex).toBeLessThan(replyIndex);
  expect(received[promptIndex]).toMatchObject({
    name: "user_message_persisted", value: { messageId: "question", text: "What happened?" }
  });
});

test("a pending Redis mirror does not block the local stream", async () => {
  const eventLog = new TurnEventLog();
  eventLog.setMirror(() => new Promise<void>(() => undefined));
  const { input, messages, reply } = runInput([
    { type: EventType.RUN_STARTED, threadId: "session-1", runId: "run-1" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "Ready" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "run-1" } as BaseEvent
  ], { eventLog });
  await streamAssistantReplyAGUI(input);
  expect(messages.contentLog.at(-1)).toEqual({ status: "completed", content: "Ready" });
  expect(reply.writes.join("")).toContain('"type":"RUN_FINISHED"');
});

test("Stop during runtime setup ends the saved turn before the graph starts", async () => {
  const cancel = new AbortController();
  const { input, messages } = runInput([], { cancelSignal: cancel.signal });
  let releaseSetup!: () => void;
  let setupEntered!: () => void;
  const setupGate = new Promise<void>((resolve) => { releaseSetup = resolve; });
  const entered = new Promise<void>((resolve) => { setupEntered = resolve; });
  const runMessageAGUI = vi.fn(async function* () { yield { type: EventType.RUN_FINISHED } as BaseEvent; });
  input.runtimeAdapter = {
    async createSession() {
      setupEntered();
      await setupGate;
      return { sessionId: "session-1", runtimeId: "runtime-1", runtimePolicy: { id: "default" } } as never;
    },
    runMessageAGUI
  } as StreamAssistantReplyAGUIInput["runtimeAdapter"];

  const pending = streamAssistantReplyAGUI(input);
  await entered;
  cancel.abort();
  releaseSetup();
  await pending;

  expect(runMessageAGUI).not.toHaveBeenCalled();
  expect(messages.contentLog.at(-1)).toEqual({ status: "interrupted", content: "" });
});

test("slow progress writes do not hold the live stream", async () => {
  const { input, reply, messages } = runInput([
    { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/plan", value: "working" }] } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hello" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "run-1" } as BaseEvent
  ]);
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  messages.updateStreamingContent = async () => { await writeGate; };

  const pending = streamAssistantReplyAGUI(input);
  await vi.waitFor(() => expect(reply.writes.some((frame) => frame.includes('"delta":"hello"'))).toBe(true));
  releaseWrite();
  await pending;
  expect(messages.contentLog.at(-1)?.status).toBe("completed");
});

test("a state delta without a plan does not write an empty plan", async () => {
  const { input, messages } = runInput([
    { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/other", value: true }] } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "run-1" } as BaseEvent
  ]);
  await streamAssistantReplyAGUI(input);
  expect(messages.streamingLog).toEqual([]);
});

test("marks a tool left open by a terminal turn as failed", async () => {
  const { input, messages } = runInput([
    { type: EventType.TOOL_CALL_START, toolCallId: "tool-1", toolCallName: "execute" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "run-1" } as BaseEvent
  ]);
  await streamAssistantReplyAGUI(input);
  expect(messages.toolResultLog.at(-1)).toMatchObject({ toolResultId: "tool-1", status: "failed" });
});

test("saves the plan, tool result, and notice before the turn ends", async () => {
  const { input, messages } = runInput([]);
  input.runtimeAdapter = {
    async createSession() {
      return { sessionId: "session-1", runtimeId: "runtime-1", runtimePolicy: { id: "default" } } as never;
    },
    async *runMessageAGUI() {
      yield { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/plan", value: "working" }] } as BaseEvent;
      await vi.waitFor(() => expect(messages.streamingLog.at(-1)).toEqual({ planContent: "working" }));
      yield { type: EventType.TOOL_CALL_START, toolCallId: "tool-1", toolCallName: "execute" } as BaseEvent;
      yield { type: EventType.TOOL_CALL_RESULT, toolCallId: "tool-1", content: "ok" } as BaseEvent;
      await vi.waitFor(() => expect(messages.toolResultLog.at(-1)).toMatchObject({ toolResultId: "tool-1", output: "ok" }));
      yield { type: EventType.CUSTOM, name: "runtime_notice", value: {
        noticeId: "notice-1", level: "warning", title: "Approval expired",
        message: "No answer", createdAt: new Date().toISOString()
      } } as BaseEvent;
      await vi.waitFor(() => expect(messages.noticeLog.at(-1)).toHaveLength(1));
      yield { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "run-1" } as BaseEvent;
    }
  } as StreamAssistantReplyAGUIInput["runtimeAdapter"];

  await streamAssistantReplyAGUI(input);
  expect(messages.contentLog.at(-1)?.status).toBe("completed");
});

test("persists a RUN_ERROR turn as error with the failure message", async () => {
  const { input, messages } = runInput([
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
    { type: EventType.RUN_ERROR, message: "provider exploded" } as BaseEvent
  ]);

  await streamAssistantReplyAGUI(input);

  // The adapter yields RUN_ERROR (it does NOT throw), so status must come from
  // the event stream — not the writer's catch. Empty partial text falls back to
  // the failure message.
  expect(messages.contentLog.at(-1)).toEqual({ status: "error", content: "provider exploded" });
});

test("persists a stop-button turn as interrupted with the partial text preserved", async () => {
  // The stop button aborts the turn; the adapter closes the stream with a
  // RUN_FINISHED carrying the private AGUI_INTERRUPTED_RESULT marker. The writer
  // must map that to a persisted 'interrupted' row (NOT 'completed') and keep
  // whatever text streamed before the stop.
  const { input, messages } = runInput([
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "partial thou" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", result: AGUI_INTERRUPTED_RESULT } as BaseEvent
  ]);

  await streamAssistantReplyAGUI(input);

  expect(messages.contentLog.at(-1)).toEqual({ status: "interrupted", content: "partial thou" });
});

test.each([
  { error: Object.assign(new Error("Session ownership mismatch"), { statusCode: 403 }),
    expected: "Session ownership mismatch" },
  { error: new Error("private setup details"), expected: "The assistant run failed." }
])("handles runtime setup failure without exposing internals: $expected", async ({ error, expected }) => {
  const { input, messages, reply, runInputs } = runInput([]);
  input.runtimeAdapter.createSession = async () => { throw error; };

  await streamAssistantReplyAGUI(input);

  const events = reply.writes.flatMap((chunk) => chunk.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as BaseEvent));
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: expected });
  expect(messages.contentLog.at(-1)).toEqual({ status: "error", content: expected });
  expect(runInputs).toHaveLength(0);
  expect(reply.raw.writableEnded).toBe(true);
});

test("threads selected artifacts into the tool context and an onBeforeTurn hook", async () => {
  let capturedMetadata: unknown;
  let capturedRunInput: { onBeforeTurn?: unknown; userInputs?: unknown } | undefined;

  const reply = makeRawResponse();
  const messages = makeMessages();
  const input = {
    reply: reply as unknown,
    messages,
    toolContexts: {
      async create(args: { metadata: unknown }) {
        capturedMetadata = args.metadata;
        return { toolContextId: "ctx-1" };
      }
    },
    runtimeAdapter: {
      async createSession() {
        return { sessionId: "session-1", runtimeId: "runtime-1", runtimePolicy: { id: "default" } };
      },
      async writeRuntimeFile() {
        return "/home/user/workspace/session-1/artifacts/a1.txt";
      },
      async *runMessageAGUI(
        _session: unknown,
        runInput: { onBeforeTurn?: (signal: AbortSignal) => Promise<void> }
      ) {
        // The onBeforeTurn hook (artifact sync + prompt build) is threaded so the
        // adapter runs it after the slot is reserved; its internals are covered
        // by turn-input-builder / SSE-path tests, so we only assert the wiring.
        capturedRunInput = runInput;
        yield { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent;
      }
    },
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    modelName: "zai/glm-4.7",
    prompt: "summarize the file",
    selectedArtifactIds: ["a1"],
    scopedArtifacts: [
      { artifactId: "a1", artifactName: "a1.txt", status: "ready", mimeType: "text/plain" }
    ],
    artifactProcessor: { async ensureRendered() { return undefined; } },
    storage: {}
  } as unknown as StreamAssistantReplyAGUIInput;

  await streamAssistantReplyAGUI(input);

  expect((capturedMetadata as { selectedArtifactIds: string[] }).selectedArtifactIds).toEqual(["a1"]);
  expect(typeof capturedRunInput?.onBeforeTurn).toBe("function");
});

test("a text_retracted marker drops the retracted prefix from persisted content", async () => {
  const { input, messages } = runInput([
    { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "refused" } as BaseEvent,
    { type: EventType.CUSTOM, name: "text_retracted", value: {} } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: "m2", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m2", delta: "the real answer" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
  ]);

  await streamAssistantReplyAGUI(input);

  expect(messages.contentLog.at(-1)).toEqual({ status: "completed", content: "the real answer" });
});

test("persists reasoning, plan, and tool results so a reload renders the full turn", async () => {
  const { input, messages } = runInput([
    { type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning" } as BaseEvent,
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r", delta: "let me think" } as BaseEvent,
    { type: EventType.REASONING_MESSAGE_END, messageId: "r" } as BaseEvent,
    { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/plan", value: "1. do it" }] } as BaseEvent,
    { type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" } as BaseEvent,
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"cmd":"ls"}' } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId: "c1" } as BaseEvent,
    { type: EventType.CUSTOM, name: "tool_meta", value: { toolCallId: "c1", kind: "command", command: "ls" } } as BaseEvent,
    { type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "file.txt" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "done" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
  ]);

  await streamAssistantReplyAGUI(input);

  expect(messages.contentLog.at(-1)).toEqual({ status: "completed", content: "done" });
  // Reasoning is persisted both as the flat fallback and as positioned segments
  // (this burst arrives before any assistant text, so offset 0).
  expect(messages.streamingLog).toEqual([
    { planContent: "1. do it" },
    { reasoningContent: "let me think", reasoningSegments: [{ offset: 0, text: "let me think" }] }
  ]);
  expect(messages.toolResultLog.at(-1)).toMatchObject({
    messageId: "msg-assistant",
    sessionId: "session-1",
    toolResultId: "c1",
    kind: "command",
    toolName: "execute",
    input: '{"cmd":"ls"}',
    output: "file.txt",
    command: "ls"
  });
});

test("remaps tool + reasoning offsets to redacted positions when the narration holds a secret (F6)", async () => {
  // Assistant narration quotes a GitHub token, then interleaves a reasoning burst
  // and a tool call. updateContent stores redactSecrets(text) (40-char token →
  // 10-char [REDACTED], −30 chars), so offsets captured against the RAW text must
  // be remapped to the redacted positions or reload slices the shortened content
  // at stale offsets.
  const token = "ghp_" + "A".repeat(36); // 40 chars
  // First text chunk ends just past the token: "token is <40> " = 24 raw chars
  // (9 + 40 + 1 space... "token is " is 9, token 40, trailing space 1 = 50).
  const firstChunk = "token is " + token + " "; // raw offset 50 after this
  const secondChunk = "then run"; // streamed after the reasoning burst opens

  const { input, messages } = runInput([
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: firstChunk } as BaseEvent,
    // Reasoning opens at raw offset 50 (= firstChunk.length) → redacted "token is
    // [REDACTED] ".length = 20.
    { type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning" } as BaseEvent,
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r", delta: "hmm" } as BaseEvent,
    { type: EventType.REASONING_MESSAGE_END, messageId: "r" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: secondChunk } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "m" } as BaseEvent,
    // Tool opens at raw offset 58 (= firstChunk+secondChunk) → redacted 28.
    { type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" } as BaseEvent,
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: "{}" } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId: "c1" } as BaseEvent,
    { type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ok" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
  ]);

  await streamAssistantReplyAGUI(input);

  // firstChunk.length = 50 → redacted prefix "token is [REDACTED] ".length = 20.
  // reasoningContent (the flat fallback) rides alongside the positioned segments.
  expect(messages.streamingLog).toEqual([
    { reasoningContent: "hmm", reasoningSegments: [{ offset: 20, text: "hmm" }] }
  ]);
  // (firstChunk+secondChunk).length = 58 → redacted length 28.
  expect(messages.toolResultLog.at(-1)?.textOffset).toBe(28);
});

test("emits a user_message_replaced CUSTOM event when a PII transform replacement is present (F8)", async () => {
  const { input, reply } = runInput(
    [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "ok" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
    ],
    { userMessageReplacement: { messageId: "u-1", text: "my card is [REDACTED]", scanRunId: "scan-9" } }
  );

  await streamAssistantReplyAGUI(input);

  const emittedEvents = reply.writes.flatMap((write) =>
    write
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent)
  );
  expect(emittedEvents.slice(0, 2).map((event) => event.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.CUSTOM
  ]);
  await expect(
    firstValueFrom(rxFrom(emittedEvents).pipe(verifyEvents(false), toArray()))
  ).resolves.toHaveLength(emittedEvents.length);

  const frame = emittedEvents.find(
    (event) => event.type === EventType.CUSTOM && event.name === "user_message_replaced"
  );
  expect(frame).toBeTruthy();
  expect(frame?.value).toEqual({ messageId: "u-1", text: "my card is [REDACTED]", scanRunId: "scan-9" });
});

test("emits the PII replacement before RUN_ERROR when setup fails before RUN_STARTED", async () => {
  const { input, reply } = runInput([], {
    userMessageReplacement: { messageId: "u-1", text: "my card is [REDACTED]", scanRunId: "scan-9" },
    runtimeAdapter: {
      async createSession() {
        throw new Error("session build failed");
      },
      async *runMessageAGUI() {}
    } as unknown as StreamAssistantReplyAGUIInput["runtimeAdapter"]
  });

  await streamAssistantReplyAGUI(input);

  const emittedEvents = reply.writes.flatMap((write) =>
    write
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent)
  );
  expect(emittedEvents.map((event) => event.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.CUSTOM,
    EventType.CUSTOM,
    EventType.RUN_ERROR
  ]);
  expect(emittedEvents[2]).toMatchObject({
    name: "user_message_replaced",
    value: { messageId: "u-1", text: "my card is [REDACTED]", scanRunId: "scan-9" }
  });
  await expect(
    firstValueFrom(rxFrom(emittedEvents).pipe(verifyEvents(false), toArray()))
  ).resolves.toHaveLength(emittedEvents.length);
});

test("emits the PII replacement before an adapter RUN_ERROR that precedes RUN_STARTED", async () => {
  const { input, reply, messages } = runInput(
    [{ type: EventType.RUN_ERROR, message: "provider key missing" } as BaseEvent],
    { userMessageReplacement: { messageId: "u-1", text: "email [REDACTED]" } }
  );

  await streamAssistantReplyAGUI(input);

  const emittedEvents = reply.writes.flatMap((write) =>
    write
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent)
  );
  expect(emittedEvents.map((event) => event.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.CUSTOM,
    EventType.CUSTOM,
    EventType.RUN_ERROR
  ]);
  await expect(
    firstValueFrom(rxFrom(emittedEvents).pipe(verifyEvents(false), toArray()))
  ).resolves.toHaveLength(emittedEvents.length);
  expect(messages.contentLog.at(-1)).toEqual({ status: "error", content: "provider key missing" });
});

test("emits NO user_message_replaced event when there is no replacement (F8)", async () => {
  const { input, reply } = runInput([
    { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
  ]);

  await streamAssistantReplyAGUI(input);

  const hasReplacement = reply.writes.some((w) => w.includes("user_message_replaced"));
  expect(hasReplacement).toBe(false);
});

test.each([
  { turnContext: "scheduled" as const, expected: "scheduled" },
  { turnContext: undefined, expected: "interactive" }
])("forwards the $expected turn context to the runtime adapter", async ({ turnContext, expected }) => {
  const { input, runInputs } = runInput(
    [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
    ],
    turnContext ? { turnContext } : {}
  );

  await streamAssistantReplyAGUI(input);

  expect(runInputs).toHaveLength(1);
  expect(runInputs[0]?.turnContext).toBe(expected);
});

// ── Review batch 3 (bead tnci), R11: incremental persistence ─────────────────

/** An adapter whose stream pauses between events, so the checkpoint timer runs. */
function makeSlowAdapter(events: BaseEvent[], gapMs: number) {
  return {
    async createSession() {
      return { sessionId: "session-1", runtimeId: "runtime-1", runtimePolicy: { id: "default" } };
    },
    async *runMessageAGUI() {
      for (const event of events) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        yield event;
      }
    }
  };
}

test("checkpoints the in-progress assistant text so a killed process leaves partial work", async () => {
  // Every path that closes the row out runs in a `finally` — and none of them
  // runs when the process is SIGKILLed or a rolling deploy replaces the task
  // mid-turn. Without a mid-turn checkpoint the row stays `pending` and EMPTY
  // forever: the UI renders a spinner that never resolves and history shows a
  // turn with no content at all. The checkpoint bounds that loss to one
  // interval.
  const { input, messages } = runInput([], {
    runtimeAdapter: makeSlowAdapter(
      [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "first half " } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "second half" } as BaseEvent,
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
      ],
      12
    ) as unknown as StreamAssistantReplyAGUIInput["runtimeAdapter"],
    streamingPersistIntervalMs: 5
  });

  await streamAssistantReplyAGUI(input);

  const streamingWrites = messages.contentLog.filter((entry) => entry.status === "streaming");
  expect(streamingWrites.length).toBeGreaterThan(0);
  // Some checkpoint captured real partial text — that is what survives a kill.
  expect(streamingWrites.some((entry) => entry.content.startsWith("first half"))).toBe(true);
  // The terminal write still owns the final status, and lands LAST: an
  // in-flight checkpoint settling afterwards would pin the row at "streaming".
  expect(messages.contentLog.at(-1)).toEqual({
    status: "completed",
    content: "first half second half"
  });
});

test("keeps checkpointing while the turn emits nothing at all", async () => {
  // A human sitting on an approval prompt produces no events for as long as
  // APPROVAL_REQUEST_TTL_MS. An event-driven checkpoint would go silent for
  // exactly that window — and `updated_at` is what the stale-message sweeper
  // reads to decide a row belongs to a live turn, so a silent turn would be
  // swept and marked interrupted underneath itself.
  const { input, messages } = runInput([], {
    runtimeAdapter: makeSlowAdapter(
      [{ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent],
      60
    ) as unknown as StreamAssistantReplyAGUIInput["runtimeAdapter"],
    streamingPersistIntervalMs: 5
  });

  await streamAssistantReplyAGUI(input);

  const streamingWrites = messages.contentLog.filter((entry) => entry.status === "streaming");
  // Several refreshes across a stretch with zero stream events.
  expect(streamingWrites.length).toBeGreaterThan(1);
  expect(messages.contentLog.at(-1)?.status).toBe("completed");
});

test("a failing checkpoint does not end a turn the client is still reading", async () => {
  // The checkpoint is crash insurance, not the render path. A transient DB
  // failure must not take down a turn that is streaming fine.
  const { input, messages } = runInput([], {
    runtimeAdapter: makeSlowAdapter(
      [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hello" } as BaseEvent,
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
      ],
      12
    ) as unknown as StreamAssistantReplyAGUIInput["runtimeAdapter"],
    streamingPersistIntervalMs: 5
  });
  let checkpointAttempts = 0;
  const realUpdate = messages.updateContent.bind(messages);
  messages.updateContent = async (
    tid: string,
    mid: string,
    uid: string,
    status: string,
    content: string
  ) => {
    if (status === "streaming") {
      checkpointAttempts += 1;
      throw new Error("connection terminated");
    }
    await realUpdate(tid, mid, uid, status, content);
  };

  await expect(streamAssistantReplyAGUI(input)).resolves.toBeUndefined();
  // Proves a checkpoint really was attempted and really did throw — without
  // this the test would also pass with checkpointing removed altogether.
  expect(checkpointAttempts).toBeGreaterThan(0);
  expect(messages.contentLog.at(-1)).toEqual({ status: "completed", content: "hello" });
});

test("a slow in-flight checkpoint cannot land after the terminal write", async () => {
  vi.useFakeTimers();
  try {
    // The failure this guards: the timer fires, its "streaming" write is still
    // awaiting the DB when the stream ends, the terminal "completed" write lands
    // first, and then the checkpoint resolves and flips the row BACK to
    // "streaming" — permanently, since nothing runs after it. That is exactly the
    // stuck-row state R11 exists to eliminate, reintroduced by its own fix.
    const { input, messages } = runInput([], {
      runtimeAdapter: makeSlowAdapter(
        [
          { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hello" } as BaseEvent,
          { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
        ],
        12
      ) as unknown as StreamAssistantReplyAGUIInput["runtimeAdapter"],
      streamingPersistIntervalMs: 5
    });
    let slowCheckpoints = 0;
    const realUpdate = messages.updateContent.bind(messages);
    messages.updateContent = async (
      tid: string,
      mid: string,
      uid: string,
      status: string,
      content: string
    ) => {
      // A checkpoint write that outlives the stream it belongs to.
      if (status === "streaming") {
        slowCheckpoints += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await realUpdate(tid, mid, uid, status, content);
    };

    const finished = streamAssistantReplyAGUI(input);
    await vi.advanceTimersByTimeAsync(36);
    expect(slowCheckpoints).toBeGreaterThan(0);
    expect(messages.contentLog.some((entry) => entry.status === "completed")).toBe(false);
    await vi.advanceTimersByTimeAsync(120);
    await finished;

    // Without this the test would also pass with checkpointing removed entirely —
    // there would simply be no late write to race.
    expect(slowCheckpoints).toBeGreaterThan(0);
    expect(messages.contentLog.at(-1)?.status).toBe("completed");
  } finally {
    vi.useRealTimers();
  }
});


test("a checkpoint that never resolves does not wedge the request", async () => {
  // The drain waits for an in-flight checkpoint so it cannot settle "streaming"
  // after the terminal status. That wait must itself be bounded: the checkpoint
  // is a database write with no cancellation, so an unbounded drain trades one
  // stuck ROW for a stuck REQUEST — no terminal update, no writer.end(), and the
  // route's turn slot held until the pool gives up. A stuck row is recoverable
  // by the sweeper; a wedged session is not.
  const { input, messages } = runInput([], {
    runtimeAdapter: makeSlowAdapter(
      [
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "hello" } as BaseEvent,
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
      ],
      12
    ) as unknown as StreamAssistantReplyAGUIInput["runtimeAdapter"],
    streamingPersistIntervalMs: 5,
    checkpointDrainDeadlineMs: 20
  });
  let stalledCheckpoints = 0;
  const realUpdate = messages.updateContent.bind(messages);
  messages.updateContent = async (
    tid: string,
    mid: string,
    uid: string,
    status: string,
    content: string
  ) => {
    if (status === "streaming") {
      stalledCheckpoints += 1;
      // Never settles — a pool that has stopped answering.
      await new Promise<void>(() => {});
      return;
    }
    await realUpdate(tid, mid, uid, status, content);
  };

  await streamAssistantReplyAGUI(input);

  expect(stalledCheckpoints).toBeGreaterThan(0);
  // The turn still recorded its outcome instead of hanging.
  expect(messages.contentLog.at(-1)?.status).toBe("completed");
});


test.each([false, true])("streams persisted turn identity before settlement, setup failure=%s", async (setupFailure) => {
  const onTurnCreated = vi.fn();
  const { input, reply, messages } = runInput([
    { type: EventType.RUN_STARTED, threadId: "session-1", runId: "msg-assistant" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "msg-assistant" } as BaseEvent
  ], { onTurnCreated });
  if (setupFailure) input.runtimeAdapter.createSession = async () => { throw new Error("setup failed"); };
  await streamAssistantReplyAGUI(input);
  expect(onTurnCreated).toHaveBeenCalledExactlyOnceWith({ messageId: "msg-assistant", sequence: 42 });
  const events = reply.writes.flatMap((write) => write.split("\n")
    .filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as BaseEvent));
  expect(events[0].type).toBe(EventType.RUN_STARTED);
  expect(events[1]).toMatchObject({ type: EventType.CUSTOM, name: "turn_started", value: { messageId: "msg-assistant", sequence: 42 } });
  expect(events.at(-1)?.type).toBe(setupFailure ? EventType.RUN_ERROR : EventType.RUN_FINISHED);
  expect(messages.contentLog.at(-1)?.status).toBe(setupFailure ? "error" : "completed");
  await expect(firstValueFrom(rxFrom(events).pipe(verifyEvents(false), toArray()))).resolves.toHaveLength(events.length);
});

test.each(["completed", "error", "interrupted", "setup-error"] as const)(
  "persists whole-turn timing before the %s terminal event", async (outcome) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const terminal = outcome === "error"
      ? { type: EventType.RUN_ERROR, message: "failed" }
      : { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", ...(outcome === "interrupted" ? { result: AGUI_INTERRUPTED_RESULT } : {}) };
    const { input } = runInput([], { startedAt: 16_000 });
    const originalCreate = input.runtimeAdapter.createSession;
    input.runtimeAdapter.createSession = async (...args) => {
      if (outcome === "setup-error") throw new Error("setup failed");
      return originalCreate(...args);
    };
    input.runtimeAdapter.runMessageAGUI = async function* () {
      yield { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent;
      yield { type: EventType.CUSTOM, name: "approval_required", value: {} } as BaseEvent;
      yield terminal as BaseEvent;
      // Adapter cleanup is outside the measured runtime.
      now.mockReturnValue(110_000);
    };
    let persisted = false;
    input.messages.updateContent = vi.fn(async (_tenant, _message, _user, status, _content, duration) => {
      expect(status).toBe(outcome === "setup-error" ? "error" : outcome);
      expect(duration).toBe(84_000);
      persisted = true;
      return null;
    });
    input.reply.raw.write = ((chunk: string) => {
      if (chunk.includes('"type":"RUN_FINISHED"') || chunk.includes('"type":"RUN_ERROR"')) {
        expect(persisted).toBe(true);
      }
      return true;
    }) as typeof input.reply.raw.write;
    try {
      await streamAssistantReplyAGUI(input);
      expect(persisted).toBe(true);
    } finally {
      now.mockRestore();
    }
  }
);

test.each([false, true])("terminates with one error when final persistence fails, retry fails=%s", async (retryFails) => {
  const { input, reply } = runInput([
    { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
  ]);
  const attemptedStatuses: string[] = [];
  input.messages.updateContent = vi.fn(async (_tenant, _message, _user, status) => {
    attemptedStatuses.push(status);
    if (status === "completed" || retryFails) throw new Error("database unavailable");
    return null;
  });
  await streamAssistantReplyAGUI(input);
  const events = reply.writes.flatMap((write) => write.split("\n")
    .filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as BaseEvent));
  expect(attemptedStatuses).toEqual(["completed", "error"]);
  expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(0);
  expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
  expect(reply.raw.writableEnded).toBe(true);
  await expect(firstValueFrom(rxFrom(events).pipe(verifyEvents(false), toArray()))).resolves.toHaveLength(events.length);
});
