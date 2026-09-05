import { describe, expect, test } from "vitest";
import type { Message } from "@cogniplane/shared-types";

import {
  planStateFromMessages,
  toAguiInitialMessages,
  toolStatusesFromMessages
} from "./agui-transcript";

function makeMessage(overrides: Partial<Message>): Message {
  return {
    role: "user",
    content: "",
    status: "completed",
    ...overrides
  } as Message;
}

describe("toAguiInitialMessages", () => {
  test("keeps user + assistant text, drops system and empty rows", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({ messageId: "u1", role: "user", content: "hello" }),
      makeMessage({ messageId: "s1", role: "system", content: "Chat titled" }),
      makeMessage({ messageId: "a1", role: "assistant", content: "hi there" }),
      makeMessage({ messageId: "a2", role: "assistant", content: "" })
    ]);
    expect(seeded).toEqual([
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: "hi there" }
    ]);
  });

  test("renders a PII-blocked system row as an assistant bubble (reload parity with the live AG-UI block)", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({
        messageId: "blk-1",
        role: "system",
        content: "Message blocked by organization policy.",
        detail: { pii: { status: "blocked", modeApplied: "block", blockReason: "email" } }
      } as Partial<Message>)
    ]);
    expect(seeded).toEqual([
      { id: "blk-1", role: "assistant", content: "Message blocked by organization policy." }
    ]);
  });

  test("does NOT render a non-blocked system row (e.g. titling) as a bubble", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({ messageId: "s1", role: "system", content: "Chat titled" }),
      makeMessage({
        messageId: "s2",
        role: "system",
        content: "some note",
        detail: { pii: { status: "detected" } }
      } as Partial<Message>)
    ]);
    expect(seeded).toEqual([]);
  });

  test("interleaves reasoning segments with text and tool cards by offset (F5)", () => {
    // Live: think → "hello" → tool → think → "bye". Reload must reproduce that
    // order, not one reasoning block up top.
    const seeded = toAguiInitialMessages([
      makeMessage({
        messageId: "a1",
        role: "assistant",
        content: "hellobye",
        reasoningContent: "firstsecond",
        reasoningSegments: [
          { offset: 0, text: "first" },
          { offset: 5, text: "second" }
        ],
        toolResults: [
          {
            toolResultId: "call-1",
            kind: "command",
            title: "execute",
            status: "completed",
            command: "ls",
            cwd: null,
            server: null,
            toolName: "execute",
            input: '{"cmd":"ls"}',
            output: "file.txt",
            exitCode: 0,
            durationMs: 12,
            textOffset: 5
          }
        ]
      } as Partial<Message>)
    ]);

    expect(seeded).toEqual([
      { id: "a1:reasoning:0", role: "reasoning", content: "first" },
      { id: "a1:text:0", role: "assistant", content: "hello" },
      { id: "a1:reasoning:1", role: "reasoning", content: "second" },
      {
        id: "a1:call:0",
        role: "assistant",
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "execute", arguments: '{"cmd":"ls"}' } }
        ]
      },
      { id: "call-1:result", role: "tool", toolCallId: "call-1", content: "file.txt" },
      { id: "a1:text:tail", role: "assistant", content: "bye" }
    ]);
  });

  test("falls back to a single reasoning block when segments are absent (legacy row)", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({
        messageId: "a1",
        role: "assistant",
        content: "answer",
        reasoningContent: "some thinking",
        reasoningSegments: null
      } as Partial<Message>)
    ]);
    // One reasoning block ahead of the body — the pre-F5 behavior, preserved.
    expect(seeded).toEqual([
      { id: "a1:reasoning", role: "reasoning", content: "some thinking" },
      { id: "a1", role: "assistant", content: "answer" }
    ]);
  });

  test("reconstructs reasoning, then the assistant message with tool calls, then tool results", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({
        messageId: "a1",
        role: "assistant",
        content: "done",
        reasoningContent: "let me think",
        toolResults: [
          {
            toolResultId: "call-1",
            kind: "command",
            title: "execute",
            status: "completed",
            command: "ls",
            cwd: null,
            server: null,
            toolName: "execute",
            input: '{"cmd":"ls"}',
            output: "file.txt",
            exitCode: 0,
            durationMs: 12
          }
        ]
      } as Partial<Message>)
    ]);

    expect(seeded).toEqual([
      { id: "a1:reasoning", role: "reasoning", content: "let me think" },
      {
        id: "a1",
        role: "assistant",
        content: "done",
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "execute", arguments: '{"cmd":"ls"}' } }
        ]
      },
      { id: "call-1:result", role: "tool", toolCallId: "call-1", content: "file.txt" }
    ]);
  });

  test("marks a failed tool result with an error and defaults empty args to {}", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({
        messageId: "a1",
        role: "assistant",
        content: "",
        toolResults: [
          {
            toolResultId: "call-x",
            kind: "mcp",
            title: "search",
            status: "failed",
            command: null,
            cwd: null,
            server: "github",
            toolName: "search",
            input: "",
            output: "boom",
            exitCode: null,
            durationMs: null
          }
        ]
      } as Partial<Message>)
    ]);

    // No content on the assistant row (it's tool-only), args fall back to "{}",
    // and the tool message carries the failure as `error`.
    expect(seeded).toEqual([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [{ id: "call-x", type: "function", function: { name: "search", arguments: "{}" } }]
      },
      { id: "call-x:result", role: "tool", toolCallId: "call-x", content: "boom", error: "failed" }
    ]);
  });

  test("marks an in_progress tool result (turn aborted mid-call) as interrupted", () => {
    // R2: a tool that started but never returned persists as "in_progress";
    // on reload it must render as interrupted, not a clean blank success.
    const seeded = toAguiInitialMessages([
      makeMessage({
        messageId: "a1",
        role: "assistant",
        content: "",
        toolResults: [
          {
            toolResultId: "call-y",
            kind: "command",
            title: "execute",
            status: "in_progress",
            command: "rm -rf build",
            cwd: null,
            server: null,
            toolName: "execute",
            input: "",
            output: "",
            exitCode: null,
            durationMs: null
          }
        ]
      } as Partial<Message>)
    ]);

    expect(seeded).toEqual([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [{ id: "call-y", type: "function", function: { name: "execute", arguments: "{}" } }]
      },
      { id: "call-y:result", role: "tool", toolCallId: "call-y", content: "", error: "interrupted" }
    ]);
  });

  test("interleaves text segments and tool cards by textOffset", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({
        messageId: "a1",
        role: "assistant",
        content: "I'll write it.Now run it.All done.",
        toolResults: [
          {
            toolResultId: "call-1",
            kind: "command",
            title: "write_file",
            status: "completed",
            command: null,
            cwd: null,
            server: null,
            toolName: "write_file",
            input: "{}",
            output: "ok",
            exitCode: 0,
            durationMs: 1,
            textOffset: "I'll write it.".length
          },
          {
            toolResultId: "call-2",
            kind: "command",
            title: "execute",
            status: "completed",
            command: null,
            cwd: null,
            server: null,
            toolName: "execute",
            input: "{}",
            output: "ran",
            exitCode: 0,
            durationMs: 1,
            textOffset: "I'll write it.Now run it.".length
          }
        ]
      } as Partial<Message>)
    ]);

    expect(seeded).toEqual([
      { id: "a1:text:0", role: "assistant", content: "I'll write it." },
      {
        id: "a1:call:0",
        role: "assistant",
        toolCalls: [{ id: "call-1", type: "function", function: { name: "write_file", arguments: "{}" } }]
      },
      { id: "call-1:result", role: "tool", toolCallId: "call-1", content: "ok" },
      // Text-segment ids are keyed on the character offset the segment starts at
      // (14 = "I'll write it.".length), stable across the merged reasoning/tool walk.
      { id: "a1:text:14", role: "assistant", content: "Now run it." },
      {
        id: "a1:call:1",
        role: "assistant",
        toolCalls: [{ id: "call-2", type: "function", function: { name: "execute", arguments: "{}" } }]
      },
      { id: "call-2:result", role: "tool", toolCallId: "call-2", content: "ran" },
      { id: "a1:text:tail", role: "assistant", content: "All done." }
    ]);
  });

  test("falls back to all-text-then-tools when tool results carry no textOffset", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({
        messageId: "a1",
        role: "assistant",
        content: "text",
        toolResults: [
          {
            toolResultId: "c1",
            kind: "command",
            title: "t",
            status: "completed",
            command: null,
            cwd: null,
            server: null,
            toolName: "t",
            input: "{}",
            output: "o",
            exitCode: null,
            durationMs: null,
            textOffset: null
          }
        ]
      } as Partial<Message>)
    ]);

    expect(seeded).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: "text",
        toolCalls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }]
      },
      { id: "c1:result", role: "tool", toolCallId: "c1", content: "o" }
    ]);
  });

  test("drops a fully-empty assistant row (no text, reasoning, or tools)", () => {
    const seeded = toAguiInitialMessages([
      makeMessage({ messageId: "a1", role: "assistant", content: "" } as Partial<Message>)
    ]);
    expect(seeded).toEqual([]);
  });
});

describe("toolStatusesFromMessages", () => {
  function assistantWith(status: string, extra: Record<string, unknown> = {}) {
    return makeMessage({
      messageId: "a1",
      role: "assistant",
      content: "",
      toolResults: [
        {
          toolResultId: "call-1",
          kind: "mcp",
          title: "search",
          status,
          command: null,
          cwd: null,
          server: "github",
          toolName: "search_repos",
          input: "",
          output: "boom",
          exitCode: null,
          durationMs: 42,
          ...extra
        }
      ]
    } as Partial<Message>);
  }

  test("reconstructs a failed tool-status row matching the live tool_status shape", () => {
    expect(toolStatusesFromMessages([assistantWith("failed")])).toEqual([
      {
        type: "tool-status",
        rowId: "tool:call-1",
        toolCallId: "call-1",
        toolName: "search_repos",
        status: "failed",
        server: "github",
        durationMs: 42
      }
    ]);
  });

  test("reconstructs a declined tool-status row", () => {
    const rows = toolStatusesFromMessages([assistantWith("declined")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("declined");
  });

  test("ignores completed and in_progress results (only failures surface live)", () => {
    expect(toolStatusesFromMessages([assistantWith("completed")])).toEqual([]);
    expect(toolStatusesFromMessages([assistantWith("in_progress")])).toEqual([]);
  });

  test("falls back to title when toolName is null and null server/duration", () => {
    const rows = toolStatusesFromMessages([
      assistantWith("failed", { toolName: null, server: null, durationMs: null })
    ]);
    expect(rows[0].toolName).toBe("search");
    expect(rows[0].server).toBeNull();
    expect(rows[0].durationMs).toBeNull();
  });

  test("skips user/system rows and returns [] when nothing failed", () => {
    expect(
      toolStatusesFromMessages([
        makeMessage({ messageId: "u1", role: "user", content: "hi" }),
        makeMessage({ messageId: "s1", role: "system", content: "titled" })
      ])
    ).toEqual([]);
  });
});

describe("planStateFromMessages", () => {
  test("takes the most recent non-empty plan markdown", () => {
    const messages = [
      makeMessage({ role: "assistant", planContent: "old plan" } as Partial<Message>),
      makeMessage({ role: "assistant", planContent: "new plan" } as Partial<Message>),
      makeMessage({ role: "assistant", planContent: "" } as Partial<Message>)
    ];
    expect(planStateFromMessages(messages)).toEqual({ plan: "new plan" });
  });

  test("returns an empty plan when nothing persisted one", () => {
    expect(planStateFromMessages([makeMessage({})])).toEqual({ plan: "" });
  });
});
