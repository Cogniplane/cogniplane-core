// ─────────────────────────────────────────────────────────────────────────────
// AG-UI turn accumulator — the persistence counterpart to the live stream
//
// The AG-UI SSE writer streams `BaseEvent`s straight to CopilotKit, which renders
// the live turn from the wire. But a reload has only the DB to read, so the rich
// parts of the turn (reasoning, tool calls/results, the plan pane) must be
// captured off the SAME event stream and persisted — otherwise reload shows
// text-only. This is a PURE reducer over the events the writer already iterates:
// feed each event to `apply`, then read `assistantText`, `reasoningText`,
// `planMarkdown`, and `toolResults()` at the end to persist.
//
// The event shapes mirror what the direct AG-UI producers emit:
//   TEXT_MESSAGE_CONTENT      → assistant text (delta)
//   REASONING_MESSAGE_CONTENT → reasoning text (delta)
//   TOOL_CALL_START           → open a tool call (toolCallId, toolCallName)
//   TOOL_CALL_ARGS            → append its input (delta)
//   TOOL_CALL_RESULT          → its output (content)
//   STATE_DELTA /plan         → plan markdown (JSON-Patch add/replace value)
//   CUSTOM tool_meta          → kind / server / command for a call
//   CUSTOM tool_status        → failed|declined + durationMs for a call
//   CUSTOM text_retracted     → drop assistant text streamed so far
//   CUSTOM tool_retracted     → drop the named tool calls (refusal fallback)
// ─────────────────────────────────────────────────────────────────────────────

import { EventType, type BaseEvent } from "@ag-ui/client";

import type { ToolResultRecord } from "./message-store.js";
import type { UiResource } from "@cogniplane/shared-types";

/** The subset of an UpsertToolResultInput this accumulator can derive from the
 *  wire — the writer fills in tenant/message/session/user before persisting. */
export type AccumulatedToolResult = {
  toolResultId: string;
  kind: ToolResultRecord["kind"];
  title: string;
  status: ToolResultRecord["status"];
  command: string | null;
  cwd: string | null;
  server: string | null;
  toolName: string | null;
  input: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  textOffset: number;
  uiResources?: UiResource[];
};

type PendingCall = {
  order: number;
  toolCallId: string;
  toolCallName: string;
  input: string;
  output: string;
  kind: ToolResultRecord["kind"];
  server: string | null;
  command: string | null;
  status: ToolResultRecord["status"];
  durationMs: number | null;
  /** Length of assistantText when this call started — its slot in the turn. */
  textOffset: number;
  /** MCP Apps UI resource blocks, carried on a tool_ui_resources CUSTOM event. */
  uiResources?: UiResource[];
};

/** A reasoning burst positioned in the turn: `text` is the burst's content and
 *  `offset` is the assistant-text length when it started (same convention as a
 *  tool call's `textOffset`), so reload can interleave it with text and cards. */
export type ReasoningSegment = {
  offset: number;
  text: string;
};

export class AguiTurnAccumulator {
  assistantText = "";
  reasoningText = "";
  planMarkdown = "";

  private readonly calls = new Map<string, PendingCall>();
  private order = 0;
  // Reasoning bursts in stream order. A new burst opens on REASONING_MESSAGE_START
  // (the translator closes the prior reasoning before each text/tool boundary, so
  // each START is a distinct positioned burst); content appends to the open one.
  private readonly reasoningSegmentList: ReasoningSegment[] = [];
  private openReasoning: ReasoningSegment | null = null;

  apply(event: BaseEvent): void {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_CONTENT:
        this.assistantText += (event as { delta?: string }).delta ?? "";
        return;

      case EventType.REASONING_MESSAGE_START: {
        // Open a fresh burst positioned at the current assistant-text length.
        this.openReasoning = { offset: this.assistantText.length, text: "" };
        this.reasoningSegmentList.push(this.openReasoning);
        return;
      }

      case EventType.REASONING_MESSAGE_CONTENT: {
        const delta = (event as { delta?: string }).delta ?? "";
        this.reasoningText += delta;
        // Guard: content without a preceding START (defensive) opens a segment
        // at the current offset so the delta is still captured positionally.
        if (!this.openReasoning) {
          this.openReasoning = { offset: this.assistantText.length, text: "" };
          this.reasoningSegmentList.push(this.openReasoning);
        }
        this.openReasoning.text += delta;
        return;
      }

      case EventType.REASONING_MESSAGE_END:
        this.openReasoning = null;
        return;

      case EventType.TOOL_CALL_START: {
        const e = event as { toolCallId?: string; toolCallName?: string };
        if (!e.toolCallId) return;
        // A repeat START for the same id keeps the first (mirrors upsert).
        if (!this.calls.has(e.toolCallId)) {
          this.calls.set(e.toolCallId, {
            order: this.order++,
            toolCallId: e.toolCallId,
            toolCallName: e.toolCallName ?? "tool",
            input: "",
            output: "",
            kind: "command",
            server: null,
            command: null,
            // Starts pending: promoted to "completed" only when a real
            // TOOL_CALL_RESULT arrives (or "failed"/"declined" via tool_status).
            // A call still "in_progress" at persist time is one the turn aborted
            // before it returned — reload renders it as unfinished rather than a
            // clean success with empty output.
            status: "in_progress",
            durationMs: null,
            // The call sits after whatever assistant text has streamed so far.
            textOffset: this.assistantText.length
          });
        }
        return;
      }

      case EventType.TOOL_CALL_ARGS: {
        const e = event as { toolCallId?: string; delta?: string };
        const call = e.toolCallId ? this.calls.get(e.toolCallId) : undefined;
        if (call) call.input += e.delta ?? "";
        return;
      }

      case EventType.TOOL_CALL_RESULT: {
        const e = event as { toolCallId?: string; content?: string };
        const call = e.toolCallId ? this.calls.get(e.toolCallId) : undefined;
        if (call) {
          call.output = e.content ?? "";
          // A result arrived → the call finished. tool_status (failed/declined)
          // is emitted AFTER TOOL_CALL_RESULT, so a failure still overrides this.
          if (call.status === "in_progress") call.status = "completed";
        }
        return;
      }

      case EventType.STATE_DELTA: {
        // The translator emits a single add/replace at "/plan" carrying the full
        // accumulated markdown each time, so take the last value we see.
        const delta = (event as { delta?: Array<{ path?: string; value?: unknown }> }).delta;
        if (!Array.isArray(delta)) return;
        for (const patch of delta) {
          if (patch?.path === "/plan" && typeof patch.value === "string") {
            this.planMarkdown = patch.value;
          }
        }
        return;
      }

      case EventType.CUSTOM: {
        const e = event as { name?: string; value?: Record<string, unknown> };
        if (e.name === "text_retracted") {
          this.assistantText = "";
          // Reasoning bursts belong to the retracted content; drop them and the
          // flat blob too so a refusal fallback doesn't leave orphaned reasoning
          // whose offsets point into text that no longer exists.
          this.reasoningText = "";
          this.reasoningSegmentList.length = 0;
          this.openReasoning = null;
          return;
        }
        if (e.name === "tool_retracted") {
          const ids = (e.value?.itemIds as string[] | undefined) ?? [];
          for (const id of ids) this.calls.delete(id);
          return;
        }
        if (e.name === "tool_meta" && e.value) {
          const call = this.calls.get(e.value.toolCallId as string);
          if (call) {
            if (e.value.kind === "mcp") call.kind = "mcp";
            call.server = (e.value.server as string | null) ?? call.server;
            call.command = (e.value.command as string | null) ?? call.command;
          }
          return;
        }
        if (e.name === "tool_status" && e.value) {
          const call = this.calls.get(e.value.toolCallId as string);
          if (call) {
            const status = e.value.status;
            if (status === "failed" || status === "declined") call.status = status;
            call.durationMs = (e.value.durationMs as number | null) ?? call.durationMs;
          }
          return;
        }
        if (e.name === "tool_ui_resources" && e.value) {
          const call = this.calls.get(e.value.toolCallId as string);
          const resources = e.value.uiResources;
          if (call && Array.isArray(resources) && resources.length > 0) {
            call.uiResources = resources as UiResource[];
          }
          return;
        }
        return;
      }

      default:
        return;
    }
  }

  /** The turn's tool results in stream order, ready to be upserted. */
  toolResults(): AccumulatedToolResult[] {
    return [...this.calls.values()]
      .sort((a, b) => a.order - b.order)
      .map((call) => ({
        toolResultId: call.toolCallId,
        kind: call.kind,
        title: call.toolCallName,
        status: call.status,
        command: call.command,
        cwd: null,
        server: call.server,
        toolName: call.toolCallName,
        input: call.input,
        output: call.output,
        exitCode: null,
        durationMs: call.durationMs,
        textOffset: call.textOffset,
        ...(call.uiResources && call.uiResources.length > 0
          ? { uiResources: call.uiResources }
          : {})
      }));
  }

  /** The turn's reasoning bursts in stream order, each positioned by `offset`.
   *  Empty (whitespace-only) bursts are dropped. Returns [] for a turn with no
   *  reasoning — the writer then persists nothing to `reasoning_segments`. */
  reasoningSegments(): ReasoningSegment[] {
    return this.reasoningSegmentList
      .map((segment) => ({ offset: segment.offset, text: segment.text.trim() }))
      .filter((segment) => segment.text.length > 0);
  }
}
