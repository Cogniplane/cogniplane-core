import { test, expect } from "vitest";

import {
  buildOptimisticMessage,
  patchMessage,
  patchToolResultOutput,
  updateMessageById,
  upsertToolResult
} from "./chat-message-state.js";
import type { Message, ToolResult } from "@cogniplane/shared-types";

function makeToolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    toolResultId: "tr-1",
    kind: "mcp",
    title: "test",
    status: "in_progress",
    command: null,
    cwd: null,
    server: null,
    toolName: null,
    input: "",
    output: "",
    exitCode: null,
    durationMs: null,
    ...overrides
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: "msg-1",
    sessionId: "sess-1",
    role: "assistant",
    status: "streaming",
    content: "",
    reasoningContent: "",
    planContent: "",
    toolResults: [],
    tokenUsage: null,
    modelName: null,
    costUsd: null,
    feedbackRating: null,
    piiScanRunId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

test("buildOptimisticMessage produces a fresh message with a unique id", () => {
  const a = buildOptimisticMessage({
    sessionId: "sess-1",
    role: "user",
    status: "pending",
    content: "hello"
  });
  const b = buildOptimisticMessage({
    sessionId: "sess-1",
    role: "user",
    status: "pending",
    content: "hello"
  });
  expect(a.messageId).not.toBe(b.messageId);
  expect(a.sessionId).toBe("sess-1");
  expect(a.role).toBe("user");
  expect(a.status).toBe("pending");
  expect(a.content).toBe("hello");
  expect(a.toolResults.length).toBe(0);
});

test("upsertToolResult appends when toolResultId is new", () => {
  const initial: ToolResult[] = [makeToolResult({ toolResultId: "a" })];
  const result = upsertToolResult(initial, makeToolResult({ toolResultId: "b" }));
  expect(result.length).toBe(2);
  expect(result[1].toolResultId).toBe("b");
  expect(result).not.toBe(initial);
});

test("upsertToolResult replaces in-place when toolResultId exists", () => {
  const initial: ToolResult[] = [
    makeToolResult({ toolResultId: "a", output: "old" }),
    makeToolResult({ toolResultId: "b", output: "x" })
  ];
  const result = upsertToolResult(
    initial,
    makeToolResult({ toolResultId: "a", output: "new", status: "completed" })
  );
  expect(result.length).toBe(2);
  expect(result[0].output).toBe("new");
  expect(result[0].status).toBe("completed");
  expect(result[1].output).toBe("x");
});

test("updateMessageById only mutates the matching message", () => {
  const messages = [
    makeMessage({ messageId: "a", content: "first" }),
    makeMessage({ messageId: "b", content: "second" })
  ];
  const result = updateMessageById(messages, "b", (msg) => ({ ...msg, content: "edited" }));
  expect(result[0].content).toBe("first");
  expect(result[1].content).toBe("edited");
  expect(result[0]).toBe(messages[0]);
});

test("updateMessageById returns input shape when id is unknown", () => {
  const messages = [makeMessage({ messageId: "a" })];
  const result = updateMessageById(messages, "missing", (msg) => ({ ...msg, content: "x" }));
  expect(result.length).toBe(1);
  expect(result[0].content).toBe("");
});

test("patchMessage merges patch and bumps updatedAt when not provided", () => {
  const messages = [makeMessage({ messageId: "a", content: "" })];
  const before = Date.now();
  const result = patchMessage(messages, "a", { content: "filled", status: "completed" });
  const after = Date.now();
  expect(result[0].content).toBe("filled");
  expect(result[0].status).toBe("completed");
  const ts = Date.parse(result[0].updatedAt);
  expect(ts >= before && ts <= after).toBeTruthy();
});

test("patchMessage preserves explicit updatedAt", () => {
  const messages = [makeMessage({ messageId: "a" })];
  const result = patchMessage(messages, "a", { updatedAt: "2030-01-01T00:00:00Z" });
  expect(result[0].updatedAt).toBe("2030-01-01T00:00:00Z");
});

test("patchToolResultOutput appends delta to the matching tool result only", () => {
  const messages = [
    makeMessage({
      messageId: "a",
      toolResults: [
        makeToolResult({ toolResultId: "tr-1", output: "abc" }),
        makeToolResult({ toolResultId: "tr-2", output: "xyz" })
      ]
    })
  ];
  const result = patchToolResultOutput(messages, "a", "tr-1", "DEF");
  expect(result[0].toolResults[0].output).toBe("abcDEF");
  expect(result[0].toolResults[1].output).toBe("xyz");
});

test("patchToolResultOutput is a no-op for an unknown toolResultId", () => {
  const messages = [
    makeMessage({
      messageId: "a",
      toolResults: [makeToolResult({ toolResultId: "tr-1", output: "abc" })]
    })
  ];
  const result = patchToolResultOutput(messages, "a", "missing", "X");
  expect(result[0].toolResults[0].output).toBe("abc");
});
