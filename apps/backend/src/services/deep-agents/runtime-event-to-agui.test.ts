// Track B — parity coverage for the RuntimeEvent → AG-UI translation. Drives
// each RuntimeEvent variant directly and asserts the emitted AG-UI events.

import { EventSchemas, EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import type { RuntimeEvent, RuntimeToolCall } from "../../runtime-contracts.js";
import {
  createRuntimeToAGUIState,
  flushOpenMessages,
  runtimeEventToAGUI
} from "./runtime-event-to-agui.js";

const RID = "resp-1";
// Validate every emitted event against AG-UI's own discriminated-union schema —
// the same shape the real runAgent() path enforces via verifyEvents. This is
// what catches role/field drift (e.g. REASONING_MESSAGE_START.role).
function assertValidAGUI(events: BaseEvent[]): void {
  for (const event of events) {
    const result = EventSchemas.safeParse(event);
    if (!result.success) {
      throw new Error(
        `Invalid AG-UI event ${String((event as { type?: string }).type)}: ${result.error.message}`
      );
    }
  }
}
function run(events: RuntimeEvent[], flush = true): BaseEvent[] {
  const state = createRuntimeToAGUIState();
  const out: BaseEvent[] = [];
  for (const e of events) out.push(...runtimeEventToAGUI(state, e));
  if (flush) out.push(...flushOpenMessages(state));
  assertValidAGUI(out);
  return out;
}
const types = (events: BaseEvent[]) => events.map((e) => e.type);
const toolCall = (over: Partial<RuntimeToolCall>): RuntimeToolCall => ({
  itemId: "tc-1",
  kind: "command",
  title: "t",
  status: "completed",
  command: null,
  cwd: null,
  server: null,
  toolName: "t",
  input: "{}",
  output: "",
  exitCode: null,
  durationMs: null,
  ...over
});

describe("runtimeEventToAGUI", () => {
  it("opens a text message lazily and streams content", () => {
    const events = run([
      { type: "response.output_text.delta", responseId: RID, delta: "a" },
      { type: "response.output_text.delta", responseId: RID, delta: "b" },
      { type: "response.output_item.done", responseId: RID }
    ]);
    expect(types(events)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END
    ]);
  });

  it("text replace emits a retraction marker, closes the open message, and restarts with full text", () => {
    const events = run([
      { type: "response.output_text.delta", responseId: RID, delta: "refused" },
      { type: "response.output_text.replace", responseId: RID, text: "the real answer" }
    ]);
    expect(types(events)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.CUSTOM, // text_retracted — signals consumers to drop the refused prefix
      EventType.TEXT_MESSAGE_END, // close refused leg
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END // flushed
    ]);
    const retraction = events.find((e) => e.type === EventType.CUSTOM);
    expect((retraction as { name?: string } | undefined)?.name).toBe("text_retracted");
  });

  it("maps reasoning deltas to REASONING_MESSAGE_* and closes on text", () => {
    const events = run([
      { type: "framework:reasoning_summary.delta", responseId: RID, delta: "hmm" },
      { type: "response.output_text.delta", responseId: RID, delta: "answer" }
    ]);
    expect(types(events)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END, // reasoning closed when text opens
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END
    ]);
    // REASONING_MESSAGE_START.role must be the literal "reasoning" (AG-UI
    // rejects "assistant" here — Codex P2).
    const reasoningStart = events.find((e) => e.type === EventType.REASONING_MESSAGE_START) as
      | (BaseEvent & { role: string })
      | undefined;
    expect(reasoningStart?.role).toBe("reasoning");
  });

  it("closes an open reasoning message before a tool call, and reopens fresh after", () => {
    // R4: reasoning-then-tool (no interstitial text) must close reasoning before
    // TOOL_CALL_START; a second reasoning block after the tool must be a NEW
    // message, not appended onto the first still-open id.
    const events = run([
      { type: "framework:reasoning_summary.delta", responseId: RID, delta: "planning" },
      { type: "response.tool.started", responseId: RID, toolCall: toolCall({}) },
      { type: "response.tool.completed", responseId: RID, toolCall: toolCall({ output: "ok" }) },
      { type: "framework:reasoning_summary.delta", responseId: RID, delta: "reflecting" }
    ]);
    expect(types(events)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END, // reasoning closed before the tool call
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.REASONING_MESSAGE_START, // fresh reasoning block after the tool
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END // flushed
    ]);
    // The two reasoning blocks are distinct messages (not merged onto one id).
    const reasoningStarts = events.filter((e) => e.type === EventType.REASONING_MESSAGE_START) as Array<
      BaseEvent & { messageId: string }
    >;
    expect(reasoningStarts).toHaveLength(2);
    expect(reasoningStarts[0]?.messageId).not.toBe(reasoningStarts[1]?.messageId);
  });

  it("reasoning replace closes the open reasoning message and reopens a fresh one with the full text", () => {
    // The refusal fallback for reasoning: reasoning_summary.replace must close the
    // current REASONING message (END) and open a NEW one (fresh messageId) with
    // the replacement text — otherwise the retracted reasoning survives in the
    // transcript concatenated with the replacement.
    const events = run([
      { type: "framework:reasoning_summary.delta", responseId: RID, delta: "wrong take" },
      { type: "framework:reasoning_summary.replace", responseId: RID, text: "corrected take" }
    ]);
    expect(types(events)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END, // close the retracted reasoning leg
      EventType.REASONING_MESSAGE_START, // fresh message for the replacement
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END // flushed
    ]);
    const starts = events.filter((e) => e.type === EventType.REASONING_MESSAGE_START) as Array<
      BaseEvent & { messageId: string }
    >;
    expect(starts).toHaveLength(2);
    expect(starts[0]?.messageId).not.toBe(starts[1]?.messageId);
    const contents = events.filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT) as Array<
      BaseEvent & { delta: string }
    >;
    expect(contents.map((c) => c.delta)).toEqual(["wrong take", "corrected take"]);
  });

  it("tool retracted emits a single tool_retracted CUSTOM carrying the itemIds", () => {
    // The tool-side refusal fallback: a retracted tool card must forward its
    // itemIds so the accumulator's remove-by-id can drop the phantom card. If the
    // ids never arrive, the removal no-ops and the card survives into the transcript.
    const events = run([
      { type: "response.tool.retracted", responseId: RID, itemIds: ["tc-1", "tc-2"] }
    ]);
    const customs = events.filter((e) => e.type === EventType.CUSTOM) as Array<
      BaseEvent & { name: string; value: unknown }
    >;
    expect(customs).toHaveLength(1);
    expect(customs[0]?.name).toBe("tool_retracted");
    expect(customs[0]?.value).toEqual({ itemIds: ["tc-1", "tc-2"] });
  });

  it("accumulates plan deltas into a STATE_DELTA on /plan", () => {
    const events = run([
      { type: "framework:plan.delta", responseId: RID, delta: "- [ ] one" },
      { type: "framework:plan.delta", responseId: RID, delta: "\n- [ ] two" }
    ]);
    const deltas = events.filter((e) => e.type === EventType.STATE_DELTA) as Array<
      BaseEvent & { delta: Array<{ op: string; path: string; value: string }> }
    >;
    expect(deltas).toHaveLength(2);
    expect(deltas[1]?.delta[0]).toEqual({
      op: "add",
      path: "/plan",
      value: "- [ ] one\n- [ ] two"
    });
  });

  it("emits TOOL_CALL_* for a tool and a tool_meta CUSTOM for MCP attribution", () => {
    const events = run([
      {
        type: "response.tool.started",
        responseId: RID,
        toolCall: toolCall({ kind: "mcp", server: "github", toolName: "create_issue" })
      },
      {
        type: "response.tool.completed",
        responseId: RID,
        toolCall: toolCall({ kind: "mcp", server: "github", output: "#42" })
      }
    ]);
    expect(types(events)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.CUSTOM, // tool_meta (server=github)
      EventType.TOOL_CALL_RESULT
    ]);
    const meta = events.find((e) => (e as { name?: string }).name === "tool_meta") as
      | (BaseEvent & { value: { server: string } })
      | undefined;
    expect(meta?.value.server).toBe("github");
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as
      | (BaseEvent & { content: string })
      | undefined;
    expect(result?.content).toBe("#42");
  });

  it("binds a tool call to the preceding assistant text via parentMessageId", () => {
    // F3: a tool that follows streamed text carries parentMessageId === that
    // text message's id, so AG-UI's defaultApplyEvents folds the tool call into
    // the same assistant message instead of splitting them apart.
    const events = run([
      { type: "response.output_text.delta", responseId: RID, delta: "hi" },
      { type: "response.tool.started", responseId: RID, toolCall: toolCall({}) }
    ]);
    const textStart = events.find((e) => e.type === EventType.TEXT_MESSAGE_START) as
      | (BaseEvent & { messageId: string })
      | undefined;
    const toolStart = events.find((e) => e.type === EventType.TOOL_CALL_START) as
      | (BaseEvent & { parentMessageId?: string })
      | undefined;
    expect(textStart?.messageId).toBeTruthy();
    expect(toolStart?.parentMessageId).toBe(textStart?.messageId);
  });

  it("omits parentMessageId when a tool follows reasoning only (no text parent)", () => {
    // A reasoning message can't own tool calls, so a tool that follows reasoning
    // with no assistant text gets no parent (would otherwise point at a closed
    // reasoning id).
    const events = run([
      { type: "framework:reasoning_summary.delta", responseId: RID, delta: "thinking" },
      { type: "response.tool.started", responseId: RID, toolCall: toolCall({}) }
    ]);
    const toolStart = events.find((e) => e.type === EventType.TOOL_CALL_START) as
      | (BaseEvent & { parentMessageId?: string })
      | undefined;
    expect(toolStart).toBeTruthy();
    expect(toolStart?.parentMessageId).toBeUndefined();
  });

  it("emits a tool_status CUSTOM (with toolName) when a tool fails", () => {
    const events = run([
      {
        type: "response.tool.completed",
        responseId: RID,
        toolCall: toolCall({ status: "failed", toolName: "execute" })
      }
    ]);
    const status = events.find((e) => (e as { name?: string }).name === "tool_status") as
      | (BaseEvent & { value: { status: string; toolName: string } })
      | undefined;
    expect(status?.value.status).toBe("failed");
    // R8: the live side-channel failure row needs the name, which is otherwise
    // only on TOOL_CALL_START.
    expect(status?.value.toolName).toBe("execute");
  });

  it("emits a tool_ui_resources CUSTOM when a completed tool carries uiResources (F7)", () => {
    const uiResources = [{ uri: "ui://card", mimeType: "text/html", text: "<b>hi</b>" }];
    const events = run([
      {
        type: "response.tool.completed",
        responseId: RID,
        toolCall: toolCall({ output: "ok", uiResources })
      }
    ]);
    const resourcesEvent = events.find(
      (e) => (e as { name?: string }).name === "tool_ui_resources"
    ) as (BaseEvent & { value: { toolCallId: string; uiResources: unknown } }) | undefined;
    expect(resourcesEvent?.value.toolCallId).toBe("tc-1");
    expect(resourcesEvent?.value.uiResources).toEqual(uiResources);
  });

  it("emits NO tool_ui_resources CUSTOM when the tool has none", () => {
    const events = run([
      { type: "response.tool.completed", responseId: RID, toolCall: toolCall({ output: "ok" }) }
    ]);
    expect(events.find((e) => (e as { name?: string }).name === "tool_ui_resources")).toBeUndefined();
  });

  it("maps framework control events to CUSTOM", () => {
    const events = run([
      {
        type: "framework:approval_required",
        responseId: RID,
        approvalId: "ap-1",
        itemId: "it-1",
        kind: "mcp_tool",
        title: "Approve?",
        summary: "delete",
        availableDecisions: ["approve", "reject"],
        command: null,
        cwd: null
      },
      {
        type: "framework:runtime_notice",
        responseId: RID,
        noticeId: "n-1",
        level: "warning",
        title: "heads up",
        message: "images unsupported",
        createdAt: "2026-07-06T00:00:00Z"
      },
      { type: "framework:mcp_server_status", serverName: "github", status: "ready" }
    ]);
    const names = events.map((e) => (e as { name?: string }).name);
    expect(events.every((e) => e.type === EventType.CUSTOM)).toBe(true);
    expect(names).toEqual(["approval_required", "runtime_notice", "mcp_server_status"]);
  });

  it("returns nothing for lifecycle events (driver owns RUN_*)", () => {
    expect(run([{ type: "response.created", responseId: RID }], false)).toEqual([]);
    expect(run([{ type: "response.completed", responseId: RID }], false)).toEqual([]);
    expect(run([{ type: "response.failed", responseId: RID, message: "boom" }], false)).toEqual([]);
  });
});
