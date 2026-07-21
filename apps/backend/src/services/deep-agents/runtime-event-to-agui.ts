// RuntimeEvent → AG-UI translation.
//
// A pure, TOTAL translation of our internal `RuntimeEvent` union into AG-UI
// `BaseEvent`s, deliberately LAYERED on top of the existing `mapDeepAgentsEvent`
// (streamEvents v2 → RuntimeEvent) rather than duplicating its extraction/
// sanitisation/MCP-attribution. The pipeline is:
//
//   streamEvents v2  --mapDeepAgentsEvent-->  RuntimeEvent  --THIS-->  AG-UI
//
// so all the battle-tested edge-case handling (Command-unwrap, NUL scrubbing,
// tool-arg JSON parsing, MCP server attribution) is reused unchanged.
//
// Lifecycle events (RUN_STARTED / RUN_FINISHED / RUN_ERROR) are owned by the
// driver (`DeepAgentsAGUIAgent`) because they need threadId/runId; this
// translator returns [] for the RuntimeEvent lifecycle triples so they are not
// double-emitted, and maps everything else.

import { EventType, type BaseEvent } from "@ag-ui/client";

import type { RuntimeEvent, RuntimeToolCall } from "../../runtime-contracts.js";
import { uuidv7 } from "../../lib/uuid.js";

export type RuntimeToAGUIState = {
  /** Open assistant text message id (null between messages). */
  textMessageId: string | null;
  /** Open reasoning message id (null between reasoning blocks). */
  reasoningMessageId: string | null;
  /** Accumulated plan markdown, mirrored into agent state as `/plan`. */
  planMarkdown: string;
};

export function createRuntimeToAGUIState(): RuntimeToAGUIState {
  return { textMessageId: null, reasoningMessageId: null, planMarkdown: "" };
}

const ASSISTANT = "assistant" as const;

// ── Turn-abort (Stop button / disconnect) terminal signal ────────────────────
//
// When the user Stops a turn (or the client disconnects), the run ends but is
// NOT a failure — we surface a clean RUN_FINISHED and persist the row as
// `status='interrupted'`. That "interrupted" flag is a Cogniplane-internal
// terminal-status hint, carried on the OPTIONAL `result` field of RUN_FINISHED
// (`result: z.any().optional()` in the AG-UI schema) and read back only by our
// own SSE writer for persistence.
//
// It is deliberately NOT expressed as `outcome:{type:"interrupt"}`. In AG-UI,
// `outcome.type === "interrupt"` is a *resume* directive: the client (and
// CopilotKit's `pendingInterrupts`) treats it as "the run paused, awaiting a
// resume". A Stop is terminal and non-resumable, so the native `outcome`
// mechanism would misrepresent it — a successful-but-early finish is the
// correct AG-UI shape, with this private field carrying our status nuance.
//
// Both the emitter (adapter turn-abort branch) and the reader (SSE writer) go
// through these helpers so the field name lives in exactly one place.
export type AGUIInterruptedResult = { interrupted: true };

/** The private `result` payload marking a RUN_FINISHED as a turn-abort. */
export const AGUI_INTERRUPTED_RESULT: AGUIInterruptedResult = { interrupted: true };

/** True when a RUN_FINISHED carries the private turn-abort marker. */
export function isAGUIInterruptedFinish(event: BaseEvent): boolean {
  if (event.type !== EventType.RUN_FINISHED) return false;
  const result = (event as { result?: { interrupted?: boolean } }).result;
  return result?.interrupted === true;
}

/** Translate one RuntimeEvent into zero or more AG-UI events. */
export function runtimeEventToAGUI(state: RuntimeToAGUIState, event: RuntimeEvent): BaseEvent[] {
  switch (event.type) {
    // ── assistant text ──────────────────────────────────────────────────────
    case "response.output_text.delta":
      return openText(state, event.delta);
    case "response.output_text.replace": {
      // Retraction (refusal fallback): close the open message and restart with
      // the full replacement text. AG-UI has no in-place text replace, so the
      // close+reopen is indistinguishable on the wire from a legitimate second
      // text block (which must concatenate). Emit an explicit `text_retracted`
      // marker first so a persistence consumer can drop the retracted prefix
      // instead of keeping both — mirroring the RuntimeEvent writer's overwrite.
      const out: BaseEvent[] = [customEvent("text_retracted", {})];
      out.push(...closeText(state));
      return out.concat(openText(state, event.text));
    }
    case "response.output_item.done":
      return closeText(state);

    // ── reasoning ─────────────────────────────────────────────────────────────
    case "framework:reasoning_summary.delta":
    case "framework:reasoning_text.delta":
      return openReasoning(state, event.delta);
    case "framework:reasoning_summary.replace": {
      const out = closeReasoning(state);
      return out.concat(openReasoning(state, event.text));
    }

    // ── plan pane (write_todos) → native STATE_DELTA ──────────────────────────
    case "framework:plan.delta": {
      // The RuntimeEvent path already flattened write_todos to accumulating
      // markdown; mirror it into agent state as `/plan`. (A later slice can emit
      // a STRUCTURED /todos patch by intercepting write_todos at the raw-event
      // layer — the eval doc's fuller "first win"; not needed for parity.)
      state.planMarkdown += event.delta;
      return [
        {
          type: EventType.STATE_DELTA,
          // "add" (not "replace") so the client JSON-Patch succeeds even though
          // the agent state has no initial `/plan` member — RFC 6902 "add" on an
          // object member creates-or-replaces, whereas "replace" requires the
          // path to already exist and is dropped otherwise (plan pane stays blank).
          delta: [{ op: "add", path: "/plan", value: state.planMarkdown }]
        } as BaseEvent
      ];
    }

    // ── tool cards ────────────────────────────────────────────────────────────
    case "response.tool.started":
      return startTool(state, event.toolCall);
    case "response.tool.completed":
      return completeTool(event.toolCall);
    case "response.tool.output.delta":
      // AG-UI has no incremental tool-output event; the terminal
      // TOOL_CALL_RESULT (from response.tool.completed) carries the full output.
      return [];
    case "response.tool.retracted":
      return [customEvent("tool_retracted", { itemIds: event.itemIds })];

    // ── framework/control events → CUSTOM (re-homed renderers) ─────────────────
    case "framework:approval_required":
      return [
        customEvent("approval_required", {
          approvalId: event.approvalId,
          itemId: event.itemId,
          kind: event.kind,
          title: event.title,
          summary: event.summary,
          availableDecisions: event.availableDecisions,
          command: event.command,
          cwd: event.cwd
        })
      ];
    case "framework:runtime_notice":
      return [
        customEvent("runtime_notice", {
          noticeId: event.noticeId,
          level: event.level,
          title: event.title,
          message: event.message,
          createdAt: event.createdAt
        })
      ];
    case "framework:mcp_server_status":
      return [
        customEvent("mcp_server_status", {
          serverName: event.serverName,
          status: event.status,
          ...(event.error ? { error: event.error } : {})
        })
      ];

    // ── lifecycle: owned by the driver (threadId/runId) — don't double-emit ────
    case "response.created":
    case "response.completed":
    case "response.failed":
      return [];

    default: {
      // Exhaustiveness guard: a new RuntimeEvent variant fails the build here.
      const _exhaustive: never = event;
      void _exhaustive;
      return [];
    }
  }
}

/** Flush any open text/reasoning message — call when the run ends. */
export function flushOpenMessages(state: RuntimeToAGUIState): BaseEvent[] {
  return closeText(state).concat(closeReasoning(state));
}

// ── text helpers ──────────────────────────────────────────────────────────────

function openText(state: RuntimeToAGUIState, delta: string): BaseEvent[] {
  if (!delta) return [];
  const out: BaseEvent[] = [];
  // A reasoning block and a text message can't be open simultaneously; text
  // starting closes reasoning.
  out.push(...closeReasoning(state));
  if (state.textMessageId === null) {
    state.textMessageId = uuidv7();
    out.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId: state.textMessageId,
      role: ASSISTANT
    } as BaseEvent);
  }
  out.push({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: state.textMessageId,
    delta
  } as BaseEvent);
  return out;
}

function closeText(state: RuntimeToAGUIState): BaseEvent[] {
  if (state.textMessageId === null) return [];
  const id = state.textMessageId;
  state.textMessageId = null;
  return [{ type: EventType.TEXT_MESSAGE_END, messageId: id } as BaseEvent];
}

// ── reasoning helpers ───────────────────────────────────────────────────────

function openReasoning(state: RuntimeToAGUIState, delta: string): BaseEvent[] {
  if (!delta) return [];
  const out: BaseEvent[] = [];
  if (state.reasoningMessageId === null) {
    state.reasoningMessageId = uuidv7();
    out.push({
      type: EventType.REASONING_MESSAGE_START,
      messageId: state.reasoningMessageId,
      // AG-UI validates REASONING_MESSAGE_START.role as the literal "reasoning"
      // (not the assistant/user/... union that TEXT_MESSAGE_START uses); the
      // real runAgent() path pipes events through verifyEvents, so "assistant"
      // here would fail the run before any answer streams.
      role: "reasoning"
    } as BaseEvent);
  }
  out.push({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: state.reasoningMessageId,
    delta
  } as BaseEvent);
  return out;
}

function closeReasoning(state: RuntimeToAGUIState): BaseEvent[] {
  if (state.reasoningMessageId === null) return [];
  const id = state.reasoningMessageId;
  state.reasoningMessageId = null;
  return [{ type: EventType.REASONING_MESSAGE_END, messageId: id } as BaseEvent];
}

// ── tool helpers ──────────────────────────────────────────────────────────────

function startTool(state: RuntimeToAGUIState, call: RuntimeToolCall): BaseEvent[] {
  const out: BaseEvent[] = [];
  // Capture the open assistant text message id BEFORE closeText nulls it — it
  // becomes the tool call's `parentMessageId` so AG-UI's defaultApplyEvents folds
  // the tool call into that same assistant message ("adds to existing if
  // parentMessageId matches") instead of splitting text and its tool calls into
  // separate assistant messages. Only text is a valid parent: a tool that follows
  // reasoning only (textMessageId === null) gets no parent, since a reasoning
  // message can't own tool calls.
  const parentMessageId = state.textMessageId;
  // A tool call closes any open assistant text OR reasoning message (a tool can
  // follow either). Symmetric with openText, which also closes reasoning first —
  // without this, reasoning-then-tool (a common Claude pattern) leaves the
  // reasoning message open across the tool call, and any post-tool interleaved
  // thinking appends onto the same id, merging two blocks into one.
  out.push(...closeText(state));
  out.push(...closeReasoning(state));
  out.push({
    type: EventType.TOOL_CALL_START,
    toolCallId: call.itemId,
    toolCallName: call.toolName ?? call.title,
    ...(parentMessageId ? { parentMessageId } : {})
  } as BaseEvent);
  out.push({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: call.itemId,
    delta: call.input ?? "{}"
  } as BaseEvent);
  out.push({ type: EventType.TOOL_CALL_END, toolCallId: call.itemId } as BaseEvent);
  // AG-UI TOOL_CALL_START carries no server/kind/command; preserve the MCP
  // attribution + shell command the mapper resolved via a CUSTOM companion so
  // no card metadata is lost.
  if (call.server || call.command || call.kind === "mcp") {
    out.push(
      customEvent("tool_meta", {
        toolCallId: call.itemId,
        kind: call.kind,
        server: call.server,
        command: call.command
      })
    );
  }
  return out;
}

function completeTool(call: RuntimeToolCall): BaseEvent[] {
  const out: BaseEvent[] = [
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: uuidv7(),
      toolCallId: call.itemId,
      // AG-UI requires `content` to be a (non-null) string; a tool that
      // completes with no output would otherwise fail the client's Zod
      // EventSchemas.parse and error the whole run. Coerce to "".
      content: call.output ?? "",
      role: "tool"
    } as BaseEvent
  ];
  // AG-UI TOOL_CALL_RESULT has no error flag; carry failed/declined status so
  // the card can still render the failure state. Include toolName so the live
  // side-channel failure row is self-sufficient — the name is otherwise only on
  // TOOL_CALL_START, and tool_meta (which carries server attribution) isn't
  // emitted for built-ins with no server/command.
  if (call.status === "failed" || call.status === "declined") {
    out.push(
      customEvent("tool_status", {
        toolCallId: call.itemId,
        toolName: call.toolName ?? call.title,
        status: call.status,
        durationMs: call.durationMs
      })
    );
  }
  // AG-UI TOOL_CALL_RESULT has no field for MCP Apps UI resource blocks; carry
  // them on a CUSTOM companion so the accumulator can persist them (parity with
  // the RuntimeEvent path, which forwards call.uiResources). No live consumer
  // renders these yet, but persisting keeps the data available for reload once a
  // uiResources renderer returns to the AG-UI surface.
  if (call.uiResources && call.uiResources.length > 0) {
    out.push(
      customEvent("tool_ui_resources", {
        toolCallId: call.itemId,
        uiResources: call.uiResources
      })
    );
  }
  return out;
}

function customEvent(name: string, value: Record<string, unknown>): BaseEvent {
  return { type: EventType.CUSTOM, name, value } as BaseEvent;
}
