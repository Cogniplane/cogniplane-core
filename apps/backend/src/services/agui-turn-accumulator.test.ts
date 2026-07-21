import { test, expect, describe } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";

import { AguiTurnAccumulator } from "./agui-turn-accumulator.js";

function e(event: Partial<BaseEvent> & { type: EventType } & Record<string, unknown>): BaseEvent {
  return event as unknown as BaseEvent;
}

function feed(events: BaseEvent[]): AguiTurnAccumulator {
  const turn = new AguiTurnAccumulator();
  for (const event of events) turn.apply(event);
  return turn;
}

describe("AguiTurnAccumulator", () => {
  test("accumulates assistant text and reasoning deltas separately", () => {
    const turn = feed([
      e({ type: EventType.REASONING_MESSAGE_CONTENT, delta: "think" }),
      e({ type: EventType.REASONING_MESSAGE_CONTENT, delta: "ing" }),
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "hel" }),
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "lo" })
    ]);
    expect(turn.reasoningText).toBe("thinking");
    expect(turn.assistantText).toBe("hello");
  });

  test("text_retracted drops assistant text streamed so far, keeps later text", () => {
    const turn = feed([
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "refused" }),
      e({ type: EventType.CUSTOM, name: "text_retracted", value: {} }),
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "real answer" })
    ]);
    expect(turn.assistantText).toBe("real answer");
  });

  test("text_retracted keeps a tool call that already ran, with its recorded offset", () => {
    // Refusal-fallback (output_text.replace → text_retracted) after a tool call
    // that actually executed. text_retracted is a TEXT-only retraction: the
    // mapper emits it independently of tool_retracted, so a call that ran before
    // the draft was replaced is legitimately retained — dropping it would lose a
    // real executed action. Its textOffset is recorded at TOOL_CALL_START and is
    // NOT rewritten by the retraction (the accumulator only touches text and
    // reasoning here), so it stays at the length of the now-retracted draft.
    // That stale offset is safe on reload: the interleaver walks insertions in
    // ascending-offset order and slices text with `content.slice(cursor, offset)`
    // (JS tolerates an offset past the end), so a card whose offset exceeds the
    // replacement text simply renders at the end — never lost, never duplicated.
    // This test pins the accumulator's raw recorded offset (the value the reload
    // path receives); the placement itself is exercised by the interleave tests
    // in chat-shell.logic.test.ts.
    const turn = feed([
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "refused draft " }),
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ran" }),
      e({ type: EventType.CUSTOM, name: "text_retracted", value: {} }),
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "real answer" })
    ]);

    expect(turn.assistantText).toBe("real answer");
    const [result] = turn.toolResults();
    // The executed call survives the retraction (unlike reasoning, which is dropped).
    expect(result?.toolResultId).toBe("c1");
    expect(result?.status).toBe("completed");
    expect(result?.output).toBe("ran");
    // Offset stays where TOOL_CALL_START recorded it — the length of the now-gone
    // "refused draft " prefix (14), NOT re-anchored to the replacement text.
    expect(result?.textOffset).toBe("refused draft ".length);
  });

  test("takes the last STATE_DELTA /plan value as the plan markdown", () => {
    const turn = feed([
      e({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/plan", value: "step 1" }] }),
      e({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/plan", value: "step 1\nstep 2" }] })
    ]);
    expect(turn.planMarkdown).toBe("step 1\nstep 2");
  });

  test("assembles a tool result from START + ARGS + RESULT with meta and status", () => {
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"cmd":' }),
      e({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '"ls"}' }),
      e({ type: EventType.CUSTOM, name: "tool_meta", value: { toolCallId: "c1", kind: "command", command: "ls" } }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "file.txt" }),
      e({ type: EventType.CUSTOM, name: "tool_status", value: { toolCallId: "c1", status: "failed", durationMs: 42 } })
    ]);

    expect(turn.toolResults()).toEqual([
      {
        toolResultId: "c1",
        kind: "command",
        title: "execute",
        status: "failed",
        command: "ls",
        cwd: null,
        server: null,
        toolName: "execute",
        input: '{"cmd":"ls"}',
        output: "file.txt",
        exitCode: null,
        durationMs: 42,
        textOffset: 0
      }
    ]);
  });

  test("a call with a RESULT and no failure is completed", () => {
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ok" })
    ]);
    expect(turn.toolResults()[0]?.status).toBe("completed");
  });

  test("a call started but never resulted (turn aborted mid-call) stays in_progress, not completed", () => {
    // R2: the abort path emits neither TOOL_CALL_RESULT nor tool_status, so the
    // call must NOT be persisted as a clean success.
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"cmd":"rm -rf build"}' })
    ]);
    const [result] = turn.toolResults();
    expect(result?.status).toBe("in_progress");
    expect(result?.output).toBe("");
  });

  test("tool_status failed (emitted after RESULT) wins over the completed promotion", () => {
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "boom" }),
      e({ type: EventType.CUSTOM, name: "tool_status", value: { toolCallId: "c1", status: "failed" } })
    ]);
    expect(turn.toolResults()[0]?.status).toBe("failed");
  });

  test("tool_status declined is a first-class terminal status (approval reject)", () => {
    // A rejected approval emits tool_status status='declined'. It is terminal
    // alongside 'failed' and must persist as 'declined' — not be swallowed into
    // the completed/in_progress promotion — so reload renders the rejection.
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.CUSTOM, name: "tool_status", value: { toolCallId: "c1", status: "declined" } })
    ]);
    expect(turn.toolResults()[0]?.status).toBe("declined");
  });

  test("tool_status carries durationMs on a successful call without forcing failure", () => {
    // durationMs is applied unconditionally, independent of the failed/declined
    // arm. A completed call reporting only a duration keeps status 'completed'
    // AND captures the timing — a regression writing duration only on the
    // failure branch would drop timing on every successful card at reload.
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ok" }),
      e({ type: EventType.CUSTOM, name: "tool_status", value: { toolCallId: "c1", durationMs: 17 } })
    ]);
    const [result] = turn.toolResults();
    expect(result?.status).toBe("completed");
    expect(result?.durationMs).toBe(17);
  });

  test("a later tool_status without durationMs does not null a previously-captured duration", () => {
    // The `?? call.durationMs` preserve-fallback: a second status update that
    // omits durationMs must keep the earlier value, not clobber it with null.
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ok" }),
      e({ type: EventType.CUSTOM, name: "tool_status", value: { toolCallId: "c1", durationMs: 17 } }),
      e({ type: EventType.CUSTOM, name: "tool_status", value: { toolCallId: "c1", status: "failed" } })
    ]);
    const [result] = turn.toolResults();
    expect(result?.status).toBe("failed");
    expect(result?.durationMs).toBe(17);
  });

  test("a duplicate TOOL_CALL_START for the same id keeps the first (idempotent re-emission)", () => {
    // A stream re-emission of TOOL_CALL_START must NOT reset a call's accumulated
    // input/output/status/textOffset. The `if (!this.calls.has(id))` guard keeps
    // the first; a dropped guard would corrupt a completed card on re-emit.
    const turn = feed([
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "abc" }), // offset 3 at first START
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "execute" }),
      e({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"cmd":"ls"}' }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ran" }),
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "defgh" }), // text advances to offset 8
      // A second START for the same id (stream re-emission) with a different name.
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "OTHER" })
    ]);

    const [result] = turn.toolResults();
    expect(result?.toolResultId).toBe("c1");
    // Everything from the FIRST start survives the re-emission.
    expect(result?.toolName).toBe("execute");
    expect(result?.input).toBe('{"cmd":"ls"}');
    expect(result?.output).toBe("ran");
    expect(result?.status).toBe("completed");
    expect(result?.textOffset).toBe(3);
  });

  test("records textOffset = assistant text length at the moment each call starts", () => {
    const turn = feed([
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "first " }),
      e({ type: EventType.TOOL_CALL_START, toolCallId: "a", toolCallName: "t1" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "a", content: "1" }),
      e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "second segment " }),
      e({ type: EventType.TOOL_CALL_START, toolCallId: "b", toolCallName: "t2" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "b", content: "2" })
    ]);
    expect(turn.toolResults().map((r) => [r.toolResultId, r.textOffset])).toEqual([
      ["a", "first ".length],
      ["b", "first second segment ".length]
    ]);
  });

  test("marks kind mcp and captures server from tool_meta", () => {
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "search" }),
      e({ type: EventType.CUSTOM, name: "tool_meta", value: { toolCallId: "c1", kind: "mcp", server: "github" } }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ok" })
    ]);
    const [result] = turn.toolResults();
    expect(result.kind).toBe("mcp");
    expect(result.server).toBe("github");
  });

  test("captures uiResources from a tool_ui_resources custom event (F7)", () => {
    const uiResources = [{ uri: "ui://card", mimeType: "text/html", text: "<b>hi</b>" }];
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "render" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ok" }),
      e({ type: EventType.CUSTOM, name: "tool_ui_resources", value: { toolCallId: "c1", uiResources } })
    ]);
    expect(turn.toolResults()[0].uiResources).toEqual(uiResources);
  });

  test("a tool with no uiResources omits the field", () => {
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "t" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ok" })
    ]);
    expect(turn.toolResults()[0].uiResources).toBeUndefined();
  });

  test("preserves tool call order across interleaved calls", () => {
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "a", toolCallName: "first" }),
      e({ type: EventType.TOOL_CALL_START, toolCallId: "b", toolCallName: "second" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "b", content: "2" }),
      e({ type: EventType.TOOL_CALL_RESULT, toolCallId: "a", content: "1" })
    ]);
    expect(turn.toolResults().map((r) => r.toolResultId)).toEqual(["a", "b"]);
  });

  test("tool_retracted removes the named calls (refusal fallback)", () => {
    const turn = feed([
      e({ type: EventType.TOOL_CALL_START, toolCallId: "a", toolCallName: "keep" }),
      e({ type: EventType.TOOL_CALL_START, toolCallId: "b", toolCallName: "drop" }),
      e({ type: EventType.CUSTOM, name: "tool_retracted", value: { itemIds: ["b"] } })
    ]);
    expect(turn.toolResults().map((r) => r.toolResultId)).toEqual(["a"]);
  });

  test("empty args default to {} at reconstruction time via the frontend, stored as-is here", () => {
    const turn = feed([e({ type: EventType.TOOL_CALL_START, toolCallId: "a", toolCallName: "t" })]);
    // The accumulator stores the raw input (""); the reload converter is what
    // substitutes "{}" for the AG-UI function.arguments field.
    expect(turn.toolResults()[0].input).toBe("");
  });

  describe("reasoning segments (F5 — interleaved reasoning reload)", () => {
    test("captures each reasoning burst positioned by the assistant-text offset", () => {
      // think → text → tool → think → text: two bursts, at offsets 0 and 5.
      const turn = feed([
        e({ type: EventType.REASONING_MESSAGE_START, messageId: "r1" }),
        e({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "first" }),
        e({ type: EventType.REASONING_MESSAGE_END, messageId: "r1" }),
        e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "hello" }),
        e({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "t" }),
        e({ type: EventType.REASONING_MESSAGE_START, messageId: "r2" }),
        e({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r2", delta: "second" }),
        e({ type: EventType.REASONING_MESSAGE_END, messageId: "r2" })
      ]);
      expect(turn.reasoningSegments()).toEqual([
        { offset: 0, text: "first" },
        { offset: 5, text: "second" }
      ]);
      // The flat fallback still concatenates every burst.
      expect(turn.reasoningText).toBe("firstsecond");
    });

    test("drops whitespace-only bursts", () => {
      const turn = feed([
        e({ type: EventType.REASONING_MESSAGE_START, messageId: "r1" }),
        e({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "   " }),
        e({ type: EventType.REASONING_MESSAGE_END, messageId: "r1" })
      ]);
      expect(turn.reasoningSegments()).toEqual([]);
    });

    test("text_retracted drops reasoning segments (refusal fallback)", () => {
      const turn = feed([
        e({ type: EventType.REASONING_MESSAGE_START, messageId: "r1" }),
        e({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "refused reasoning" }),
        e({ type: EventType.REASONING_MESSAGE_END, messageId: "r1" }),
        e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "refused" }),
        e({ type: EventType.CUSTOM, name: "text_retracted" })
      ]);
      expect(turn.reasoningSegments()).toEqual([]);
      expect(turn.reasoningText).toBe("");
    });

    test("no reasoning → empty segment list", () => {
      const turn = feed([e({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "hi" })]);
      expect(turn.reasoningSegments()).toEqual([]);
    });
  });
});
