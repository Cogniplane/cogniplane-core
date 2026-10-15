import { EventType } from "@ag-ui/client";
import { describe, expect, test } from "vitest";

import {
  hasReplyAfterLastPrompt,
  historyRunEvents,
  planStateFromMessages,
  toAguiMessages,
  type HistoryMessage
} from "./agui-history.js";

// Test rows carry the full saved shape. The conversion reads only part of it.
function makeMessage(fields: Record<string, unknown>): HistoryMessage {
  return { role: "user", content: "", status: "completed", ...fields } as HistoryMessage;
}

test("does not copy a retained legacy inline resource into the history", () => {
  // Rows saved before the inline resource contract was retired keep uiResources.
  const tool = {
    toolResultId: "call-1", kind: "mcp", title: "legacy_widget", status: "completed",
    command: null, cwd: null, server: "legacy", toolName: "legacy_widget",
    input: "{}", output: "[interactive UI: ui://legacy/card]", exitCode: null, durationMs: 1, textOffset: 0,
    uiResources: [{ uri: "ui://legacy/card", mimeType: "text/html", text: "<b>retained-html</b>" }]
  };
  const converted = toAguiMessages([makeMessage({ messageId: "a1", role: "assistant", content: "", toolResults: [tool] })]);
  expect(converted).toContainEqual({ id: "call-1:result", role: "tool", toolCallId: "call-1", content: "[interactive UI: ui://legacy/card]" });
  expect(JSON.stringify(converted)).not.toContain("retained-html");
});

describe("toAguiMessages", () => {
  test("keeps user + assistant text, drops system and empty rows", () => {
    const seeded = toAguiMessages([
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

  test("renders a PII-blocked system row as an assistant bubble (history matches the live AG-UI block)", () => {
    const seeded = toAguiMessages([
      makeMessage({
        messageId: "blk-1",
        role: "system",
        content: "Message blocked by organization policy.",
        detail: { pii: { status: "blocked", modeApplied: "block", blockReason: "email" } }
      })
    ]);
    expect(seeded).toEqual([
      { id: "blk-1", role: "assistant", content: "Message blocked by organization policy." }
    ]);
  });

  test("does NOT render a non-blocked system row (e.g. titling) as a bubble", () => {
    const seeded = toAguiMessages([
      makeMessage({ messageId: "s1", role: "system", content: "Chat titled" }),
      makeMessage({
        messageId: "s2",
        role: "system",
        content: "some note",
        detail: { pii: { status: "detected" } }
      })
    ]);
    expect(seeded).toEqual([]);
  });

  test("interleaves reasoning segments with text and tool cards by offset (F5)", () => {
    // Live: think → "hello" → tool → think → "bye". Reload must reproduce that
    // order, not one reasoning block up top.
    const seeded = toAguiMessages([
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
      })
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

  test("puts reasoning and a tool call that start the turn before its text", () => {
    const seeded = toAguiMessages([
      makeMessage({
        messageId: "a1",
        role: "assistant",
        content: "done",
        reasoningContent: "let me think",
        reasoningSegments: [{ offset: 0, text: "let me think" }],
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
            textOffset: 0
          }
        ]
      })
    ]);

    expect(seeded).toEqual([
      { id: "a1:reasoning:0", role: "reasoning", content: "let me think" },
      {
        id: "a1:call:0",
        role: "assistant",
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "execute", arguments: '{"cmd":"ls"}' } }
        ]
      },
      { id: "call-1:result", role: "tool", toolCallId: "call-1", content: "file.txt" },
      { id: "a1:text:tail", role: "assistant", content: "done" }
    ]);
  });

  test("marks a failed tool result with an error and defaults empty args to {}", () => {
    const seeded = toAguiMessages([
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
            durationMs: null,
            textOffset: 0
          }
        ]
      })
    ]);

    // No content on the assistant row (it's tool-only), args fall back to "{}",
    // and the tool message carries the failure as `error`.
    expect(seeded).toEqual([
      {
        id: "a1:call:0",
        role: "assistant",
        toolCalls: [{ id: "call-x", type: "function", function: { name: "search", arguments: "{}" } }]
      },
      { id: "call-x:result", role: "tool", toolCallId: "call-x", content: "boom", error: "failed" }
    ]);
  });

  test("marks an in_progress tool result (turn aborted mid-call) as interrupted", () => {
    // R2: a tool that started but never returned persists as "in_progress";
    // on reload it must render as interrupted, not a clean blank success.
    const seeded = toAguiMessages([
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
            durationMs: null,
            textOffset: 0
          }
        ]
      })
    ]);

    expect(seeded).toEqual([
      {
        id: "a1:call:0",
        role: "assistant",
        toolCalls: [{ id: "call-y", type: "function", function: { name: "execute", arguments: "{}" } }]
      },
      { id: "call-y:result", role: "tool", toolCallId: "call-y", content: "", error: "interrupted" }
    ]);
  });

  test("interleaves text segments and tool cards by textOffset", () => {
    const seeded = toAguiMessages([
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
      })
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

  test("drops a fully-empty assistant row (no text, reasoning, or tools)", () => {
    const seeded = toAguiMessages([
      makeMessage({ messageId: "a1", role: "assistant", content: "" })
    ]);
    expect(seeded).toEqual([]);
  });
});

describe("planStateFromMessages", () => {
  test("takes the most recent non-empty plan markdown", () => {
    const messages = [
      makeMessage({ role: "assistant", planContent: "old plan" }),
      makeMessage({ role: "assistant", planContent: "new plan" }),
      makeMessage({ role: "assistant", planContent: "" })
    ];
    expect(planStateFromMessages(messages)).toEqual({ plan: "new plan" });
  });

  test("returns an empty plan when nothing persisted one", () => {
    expect(planStateFromMessages([makeMessage({ messageId: "a1", role: "assistant" })])).toEqual({ plan: "" });
  });
});


describe("hasReplyAfterLastPrompt", () => {
  const prompt = makeMessage({ messageId: "u2", role: "user", content: "Next" });
  const earlier = [
    makeMessage({ messageId: "u1", role: "user", content: "First" }),
    makeMessage({ messageId: "a1", role: "assistant", content: "Answer" })
  ];

  test("is false when the newest prompt has no reply, or only an empty reply row", () => {
    expect(hasReplyAfterLastPrompt([...earlier, prompt])).toBe(false);
    expect(hasReplyAfterLastPrompt([...earlier, prompt, makeMessage({ messageId: "a2", role: "assistant", status: "pending" })])).toBe(false);
  });

  test("is true for a reply with text, or with only a saved plan", () => {
    expect(hasReplyAfterLastPrompt(earlier)).toBe(true);
    expect(hasReplyAfterLastPrompt([...earlier, prompt, makeMessage({
      messageId: "a2", role: "assistant", status: "streaming", planContent: "- [ ] step"
    })])).toBe(true);
  });
});

describe("historyRunEvents", () => {
  test("wraps the snapshots in a finished run without input messages", () => {
    const events = historyRunEvents({
      threadId: "s-1",
      runId: "history:1",
      messages: [
        makeMessage({ messageId: "u1", role: "user", content: "hello" }),
        makeMessage({ messageId: "a1", role: "assistant", content: "hi", planContent: "- [ ] step" })
      ],
      connection: { activeTurn: "attached", hasMoreHistory: true }
    });
    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: "s-1", runId: "history:1" },
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "u1", role: "user", content: "hello" }, { id: "a1", role: "assistant", content: "hi" }]
      },
      { type: EventType.STATE_SNAPSHOT, snapshot: { plan: "- [ ] step" } },
      { type: EventType.CUSTOM, name: "session_connection", value: { activeTurn: "attached", hasMoreHistory: true } },
      { type: EventType.RUN_FINISHED, threadId: "s-1", runId: "history:1" }
    ]);
  });
});
