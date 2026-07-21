import { test, expect } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";

import { streamAssistantReplyAGUI, type StreamAssistantReplyAGUIInput } from "./sse-stream-writer-agui.js";
import { AGUI_INTERRUPTED_RESULT } from "./deep-agents/runtime-event-to-agui.js";

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
  return {
    contentLog,
    streamingLog,
    toolResultLog,
    async create() {
      return { messageId: "msg-assistant" };
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

function makeAdapter(events: BaseEvent[]) {
  return {
    async createSession() {
      return { sessionId: "session-1", runtimeId: "runtime-1", runtimePolicy: { id: "default" } };
    },
    async *runMessageAGUI() {
      for (const event of events) yield event;
    }
  };
}

function runInput(events: BaseEvent[], extra: Partial<StreamAssistantReplyAGUIInput> = {}) {
  const reply = makeRawResponse();
  const messages = makeMessages();
  const input = {
    reply: reply as unknown,
    messages,
    toolContexts: makeToolContexts(),
    runtimeAdapter: makeAdapter(events),
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    modelName: "zai/glm-4.7",
    prompt: "hi",
    ...extra
  } as unknown as StreamAssistantReplyAGUIInput;
  return { input, messages, reply };
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
      async *runMessageAGUI(_session: unknown, runInput: { onBeforeTurn?: () => Promise<void> }) {
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
    {
      reasoningContent: "let me think",
      reasoningSegments: [{ offset: 0, text: "let me think" }],
      planContent: "1. do it"
    }
  ]);
  expect(messages.toolResultLog).toHaveLength(1);
  expect(messages.toolResultLog[0]).toMatchObject({
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
  expect(messages.toolResultLog).toHaveLength(1);
  expect(messages.toolResultLog[0].textOffset).toBe(28);
});

test("emits a user_message_replaced CUSTOM event when a PII transform replacement is present (F8)", async () => {
  const { input, reply } = runInput(
    [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "ok" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent
    ],
    { userMessageReplacement: { messageId: "u-1", text: "my card is [REDACTED]", scanRunId: "scan-9" } }
  );

  await streamAssistantReplyAGUI(input);

  const frame = reply.writes
    .map((w) => {
      const line = w.split("\n").find((l) => l.startsWith("data: "));
      return line ? (JSON.parse(line.slice("data: ".length)) as Record<string, unknown>) : null;
    })
    .find((f) => f?.type === "CUSTOM" && f?.name === "user_message_replaced");
  expect(frame).toBeTruthy();
  expect(frame?.value).toEqual({ messageId: "u-1", text: "my card is [REDACTED]", scanRunId: "scan-9" });
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
