import { test, expect } from "vitest";

import type { RuntimeEvent } from "../runtime-contracts.js";
import { ActiveTurnMessageMap } from "./active-turn-message-map.js";
import { streamAssistantReply } from "./sse-stream-writer.js";

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeRawResponse() {
  const written: string[] = [];
  let ended = false;
  return {
    raw: {
      write(chunk: string) {
        written.push(chunk);
      },
      end() {
        ended = true;
      }
    },
    get written() {
      return written;
    },
    get ended() {
      return ended;
    },
    events() {
      return written.flatMap((chunk) =>
        chunk
          .split("\n\n")
          .filter(Boolean)
          .map((frame) => {
            const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            return {
              event: eventLine?.slice(7) ?? "",
              data: dataLine ? (JSON.parse(dataLine.slice(6)) as Record<string, unknown>) : {}
            };
          })
      );
    }
  };
}

type FakeReply = ReturnType<typeof makeRawResponse>;

function makeMessages(messageId = "msg-assistant") {
  const contentLog: Array<{ status: string; content: string }> = [];
  const toolResultLog: Array<Record<string, unknown>> = [];
  const toolOutputDeltaLog: Array<{ toolResultId: string; delta: string }> = [];
  const tokenUsageLog: Array<{
    tokenUsage: { totalTokens: number; inputTokens: number; outputTokens: number };
    modelName: string;
    costUsd: number | null;
  }> = [];
  return {
    contentLog,
    toolResultLog,
    toolOutputDeltaLog,
    tokenUsageLog,
    async create(input: { role: string }) {
      return {
        id: 1,
        messageId: input.role === "assistant" ? messageId : "msg-user",
        sessionId: "session-1",
        userId: "user-1",
        role: input.role as "user" | "assistant",
        status: "pending" as const,
        content: "",
        tokenUsage: null,
        modelName: null,
        costUsd: null,
        toolResults: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    },
    async updateContent(_tid: string, _mid: string, _uid: string, status: string, content: string) {
      contentLog.push({ status, content });
      return null;
    },
    async updateStreamingContent() {
      // no-op in tests
    },
    async upsertToolResult(input: Record<string, unknown>) {
      toolResultLog.push(input);
      return {
        id: 1,
        toolResultId: String(input.toolResultId),
        messageId: String(input.messageId),
        sessionId: "session-1",
        userId: "user-1",
        kind: "command" as const,
        title: "",
        status: "in_progress" as const,
        command: null,
        cwd: null,
        server: null,
        toolName: null,
        input: "",
        output: "",
        exitCode: null,
        durationMs: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    },
    async appendToolResultOutput(_tid: string, toolResultId: string, _uid: string, delta: string) {
      toolOutputDeltaLog.push({ toolResultId, delta });
      return null;
    },
    async updateTokenUsage(
      _tid: string,
      _mid: string,
      _uid: string,
      tokenUsage: { totalTokens: number; inputTokens: number; outputTokens: number },
      modelName: string,
      costUsd: number | null
    ) {
      tokenUsageLog.push({ tokenUsage, modelName, costUsd });
    }
  };
}

function makeToolContexts() {
  return {
    async create() {
      return {
        toolContextId: "ctx-1",
        tenantId: "tenant-1",
        sessionId: "session-1",
        userId: "user-1",
        runtimeId: "runtime-1",
        runtimePolicyId: "default",
        messageId: null,
        credentialEnvelope: {},
        metadata: {},
        expiresAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };
    }
  };
}

function makeRuntimeManager(events: RuntimeEvent[]) {
  return {
    async createSession() {
      return {
        sessionId: "session-1",
        runtimeId: "runtime-1",
        runtimePolicy: {
          id: "default",
          label: "Default",
          description: null,
          runtimeProvider: "codex" as const,
          approvalPolicy: "never" as const,
          approvalReviewer: "user" as const,
          sandboxMode: "workspace-write" as const,
          networkMode: "restricted" as const,
          allowCommandExecution: false,
          allowUserTokenForwarding: false,
          autoApproveReadOnlyTools: false,
          developerInstructions: null,
          enabledToolIds: [],
          enabledMcpServers: [],
          version: 1,
          hash: "h"
        }
      };
    },
    async *runMessage() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

function makeInput(reply: FakeReply, events: RuntimeEvent[], overrides: Record<string, unknown> = {}) {
  return {
    reply: reply as unknown as import("fastify").FastifyReply,
    messages: makeMessages() as ReturnType<typeof makeMessages>,
    toolContexts: makeToolContexts(),
    runtimeManager: makeRuntimeManager(events),
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    modelName: "gpt-5.4",
    prompt: "Hello",
    activeTurnMessageMap: new ActiveTurnMessageMap(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("streamAssistantReply writes response.created SSE frame and ends the stream", async () => {
  const reply = makeRawResponse();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    { type: "response.completed", responseId: "r1" }
  ];

  await streamAssistantReply(makeInput(reply, events) as Parameters<typeof streamAssistantReply>[0]);

  const sseEvents = reply.events();
  expect(sseEvents.some((e) => e.event === "response.created")).toBeTruthy();
  expect(reply.ended).toBeTruthy();
});

test("streamAssistantReply accumulates text deltas and marks message completed", async () => {
  const reply = makeRawResponse();
  const messages = makeMessages();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    { type: "response.output_text.delta", responseId: "r1", delta: "Hello" },
    { type: "response.output_text.delta", responseId: "r1", delta: " world" },
    { type: "response.output_item.done", responseId: "r1" },
    { type: "response.completed", responseId: "r1" }
  ];

  const input = makeInput(reply, events) as Parameters<typeof streamAssistantReply>[0];
  (input as Record<string, unknown>).messages = messages;

  await streamAssistantReply(input);

  const sseEvents = reply.events();
  const deltaEvents = sseEvents.filter((e) => e.event === "response.output_text.delta");
  expect(deltaEvents.length).toBe(2);

  // output_item.done persists the in-progress content with status="streaming"
  // so the row doesn't prematurely flip to "completed" on the first
  // assistant block of a multi-step turn (see Claude multi-step test below).
  const itemDonePersist = messages.contentLog.find((e) => e.status === "streaming");
  expect(itemDonePersist).toBeTruthy();
  expect(itemDonePersist?.content).toBe("Hello world");

  // response.completed writes the terminal "completed" status.
  const completedPersist = messages.contentLog.find((e) => e.status === "completed");
  expect(completedPersist).toBeTruthy();
  expect(completedPersist?.content).toBe("Hello world");

  // Terminal status is "completed" and arrives after the streaming persist.
  const lastPersist = messages.contentLog[messages.contentLog.length - 1];
  expect(lastPersist?.status).toBe("completed");
});

test("streamAssistantReply keeps status 'streaming' across Claude multi-step turn", async () => {
  // For a multi-step Claude turn (assistant → tool → assistant → …), the SDK
  // emits `response.output_item.done` after every assistant block. None of
  // those intermediate events should mark the message "completed" — only
  // the final `response.completed` should.
  const reply = makeRawResponse();
  const messages = makeMessages();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    { type: "response.output_text.delta", responseId: "r1", delta: "Looking…" },
    { type: "response.output_item.done", responseId: "r1" },
    // second assistant block after a tool round-trip
    { type: "response.output_text.delta", responseId: "r1", delta: " done." },
    { type: "response.output_item.done", responseId: "r1" },
    { type: "response.completed", responseId: "r1" }
  ];

  const input = makeInput(reply, events) as Parameters<typeof streamAssistantReply>[0];
  (input as Record<string, unknown>).messages = messages;

  await streamAssistantReply(input);

  // The first persist must NOT be "completed" — that was the premature-pill bug.
  const statusesInOrder = messages.contentLog.map((e) => e.status);
  const firstCompletedIndex = statusesInOrder.indexOf("completed");
  const lastStreamingIndex = statusesInOrder.lastIndexOf("streaming");
  expect(firstCompletedIndex > lastStreamingIndex).toBeTruthy();

  const completedPersist = messages.contentLog.find((e) => e.status === "completed");
  expect(completedPersist).toBeTruthy();
  expect(completedPersist?.content).toBe("Looking… done.");
});

test("streamAssistantReply persists partial assistant text under 'interrupted' status when the turn was stopped", async () => {
  // Stop button — the runtime emits response.completed { interrupted: true }
  // after the user clicked Stop mid-turn. The writer must persist whatever
  // text streamed so far with status='interrupted' (not 'completed', not
  // 'error') so the bubble renders a "Stopped" badge and any token usage
  // observed up to interrupt is recorded for accounting.
  const reply = makeRawResponse();
  const messages = makeMessages();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    { type: "response.output_text.delta", responseId: "r1", delta: "I was about to" },
    { type: "response.completed", responseId: "r1", interrupted: true }
  ];

  const input = makeInput(reply, events) as Parameters<typeof streamAssistantReply>[0];
  (input as Record<string, unknown>).messages = messages;

  await streamAssistantReply(input);

  // Terminal persisted status must be 'interrupted', not 'completed'.
  const lastPersist = messages.contentLog[messages.contentLog.length - 1];
  expect(lastPersist?.status).toBe("interrupted");
  expect(lastPersist?.content).toBe("I was about to");

  // The wire frame must surface response.status="interrupted" so the frontend
  // can branch on it without inventing a new event name.
  const sseEvents = reply.events();
  const completed = sseEvents.find((e) => e.event === "response.completed");
  expect(completed).toBeTruthy();
  expect((completed?.data as { response?: { status?: string } } | undefined)?.response?.status).toBe(
    "interrupted"
  );

  // Token usage is no longer captured in the runtime layer — the LLM proxy
  // writes it directly to messages.cost_usd. See llm-anthropic.test.ts /
  // llm-openai.test.ts for the usage-attribution coverage.
});

test("streamAssistantReply writes response.failed SSE frame and ends stream on runtime failure", async () => {
  const reply = makeRawResponse();
  const messages = makeMessages();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    { type: "response.failed", responseId: "r1", message: "Runtime exploded" }
  ];

  const input = makeInput(reply, events) as Parameters<typeof streamAssistantReply>[0];
  (input as Record<string, unknown>).messages = messages;

  await streamAssistantReply(input);

  const sseEvents = reply.events();
  expect(sseEvents.some((e) => e.event === "response.failed")).toBeTruthy();
  expect(reply.ended).toBeTruthy();

  const errorPersist = messages.contentLog.find((e) => e.status === "error");
  expect(errorPersist).toBeTruthy();
});

test("streamAssistantReply appends artifact provenance before response.completed", async () => {
  const reply = makeRawResponse();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    { type: "response.output_text.delta", responseId: "r1", delta: "Answer" },
    { type: "response.output_item.done", responseId: "r1" },
    { type: "response.completed", responseId: "r1" }
  ];

  await streamAssistantReply(
    makeInput(reply, events, { sourceArtifactNames: ["doc.pdf", "report.xlsx"] }) as Parameters<
      typeof streamAssistantReply
    >[0]
  );

  const sseEvents = reply.events();
  const provenanceDelta = sseEvents
    .filter((e) => e.event === "response.output_text.delta")
    .find((e) => typeof e.data.delta === "string" && (e.data.delta as string).includes("Sources:"));

  expect(provenanceDelta).toBeTruthy();
});

test("streamAssistantReply forwards reasoning summaries and runtime notices", async () => {
  const reply = makeRawResponse();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    { type: "framework:reasoning_summary.delta", responseId: "r1", delta: "Checking available MCP tools." },
    {
      type: "framework:runtime_notice",
      responseId: "r1",
      noticeId: "notice-1",
      level: "warning",
      title: "Runtime reconnecting",
      message: "WebSocket disconnected while streaming.",
      createdAt: "2026-04-09T00:00:00.000Z"
    },
    { type: "response.completed", responseId: "r1" }
  ];

  await streamAssistantReply(makeInput(reply, events) as Parameters<typeof streamAssistantReply>[0]);

  const sseEvents = reply.events();
  expect(sseEvents.some(
          (event) =>
            event.event === "framework:reasoning_summary.delta" &&
            event.data.delta === "Checking available MCP tools."
        )).toBeTruthy();
  expect(sseEvents.some(
          (event) =>
            event.event === "framework:runtime_notice" &&
            typeof event.data.notice === "object" &&
            event.data.notice !== null &&
            (event.data.notice as Record<string, unknown>).message === "WebSocket disconnected while streaming."
        )).toBeTruthy();
});

test("streamAssistantReply redacts secrets from persisted tool input/output and output deltas", async () => {
  const reply = makeRawResponse();
  const messages = makeMessages();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    {
      type: "response.tool.started",
      responseId: "r1",
      toolCall: {
        itemId: "tool-1",
        kind: "mcp",
        title: "github_read_file",
        status: "in_progress",
        command: null,
        cwd: null,
        server: "github",
        toolName: "github_read_file",
        input: "tool request Authorization: Bearer fake-session-token",
        output: "",
        exitCode: null,
        durationMs: null
      }
    },
    {
      type: "response.tool.output.delta",
      responseId: "r1",
      itemId: "tool-1",
      delta: "Authorization: Bearer fake-delta-token"
    },
    {
      type: "response.tool.completed",
      responseId: "r1",
      toolCall: {
        itemId: "tool-1",
        kind: "mcp",
        title: "github_read_file",
        status: "completed",
        command: null,
        cwd: null,
        server: "github",
        toolName: "github_read_file",
        input: "tool request Authorization: Bearer fake-session-token",
        output: "response body: github-token-like-placeholder",
        exitCode: 0,
        durationMs: 42
      }
    },
    { type: "response.completed", responseId: "r1" }
  ];

  const input = makeInput(reply, events) as Parameters<typeof streamAssistantReply>[0];
  (input as Record<string, unknown>).messages = messages;

  await streamAssistantReply(input);

  expect(messages.toolResultLog.length).toBe(2);

  for (const persisted of messages.toolResultLog) {
    const inputText = String(persisted.input ?? "");
    const outputText = String(persisted.output ?? "");
    expect(!/ghp_[A-Za-z0-9_]+/.test(inputText)).toBeTruthy();
    expect(!/ghp_[A-Za-z0-9_]+/.test(outputText)).toBeTruthy();
    expect(!/gho_[A-Za-z0-9_]+/.test(outputText)).toBeTruthy();
    expect(!/Bearer\s+(?!\[REDACTED\])\S+/.test(inputText)).toBeTruthy();
    expect(!/Bearer\s+(?!\[REDACTED\])\S+/.test(outputText)).toBeTruthy();
  }

  expect(messages.toolOutputDeltaLog.length).toBe(1);
  const deltaText = messages.toolOutputDeltaLog[0]!.delta;
  expect(!/ghp_[A-Za-z0-9_]+/.test(deltaText)).toBeTruthy();
  expect(!/Bearer\s+(?!\[REDACTED\])\S+/.test(deltaText)).toBeTruthy();
});

test("streamAssistantReply completes without cleanup callbacks", async () => {
  const reply = makeRawResponse();
  const events: RuntimeEvent[] = [
    { type: "response.created", responseId: "r1" },
    { type: "response.completed", responseId: "r1" }
  ];

  await streamAssistantReply(
    makeInput(reply, events) as Parameters<typeof streamAssistantReply>[0]
  );

  // Cleanup is now handled internally by runRuntimeTurn for artifact processing.
  // This test verifies the stream completes cleanly without external cleanup callbacks.
  expect(true).toBeTruthy();
});
