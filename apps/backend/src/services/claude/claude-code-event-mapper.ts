
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { uuidv7 } from "../../lib/uuid.js";

import type { RuntimeEvent, RuntimeToolCall } from "../../runtime-contracts.js";

/** Accepted input: typed SDK messages (local path) or untyped JSON (E2B CLI path). */
export type ClaudeMessageInput = SDKMessage | Record<string, unknown>;

type PendingToolCall = {
  toolCall: RuntimeToolCall;
  inputJsonBuffer: string;
  startedAt: number;
};

export type ClaudeEventMapperState = {
  responseId: string;
  lastToolUseId: string | null;
  // True when at least one stream_event/text_delta was emitted for the current
  // assistant message. Used to suppress the assistant snapshot text fallback
  // and avoid duplicating the reply (once via deltas, once via snapshot).
  assistantTextStreamed: boolean;
  // Pending tool calls keyed by tool_use_id, used to finalize input from
  // input_json_delta accumulation and to emit tool.completed when the matching
  // tool_result arrives in a subsequent user message.
  pendingToolCalls: Map<string, PendingToolCall>;
  // content_block index → tool_use_id, so input_json_delta / content_block_stop
  // (which carry an index, not an id) can find their pending tool call.
  indexToToolUseId: Map<number, string>;
  // Last `error` seen on an assistant message (SDKAssistantMessageError, e.g.
  // "model_not_found"). The terminal result message carries only a generic
  // `errors[]` / subtype, so we stash the typed assistant error here to turn it
  // into an actionable failure message in mapResult.
  assistantError: string | null;
};

export function createClaudeEventMapperState(responseId: string): ClaudeEventMapperState {
  return {
    responseId,
    lastToolUseId: null,
    assistantTextStreamed: false,
    pendingToolCalls: new Map(),
    indexToToolUseId: new Map(),
    assistantError: null
  };
}

/**
 * Maps a Claude Agent SDK message to zero or more RuntimeEvents.
 *
 * Accepts both typed `SDKMessage` (local SDK path) and untyped
 * `Record<string, unknown>` (E2B CLI JSON path). Returns an empty array
 * for unrecognised message shapes so callers can safely spread the result
 * into their event stream.
 */
export function mapClaudeEvent(
  state: ClaudeEventMapperState,
  message: ClaudeMessageInput
): RuntimeEvent[] {
  // Narrow to loose record for dynamic property access inside the mapper.
  // The typed union signature ensures callers pass valid SDK messages.
  const msg = message as Record<string, unknown>;
  return mapLooseMessage(state, msg);
}

function mapLooseMessage(
  state: ClaudeEventMapperState,
  message: Record<string, unknown>
): RuntimeEvent[] {
  const type = message.type as string | undefined;

  switch (type) {
    // ── 1. system init ───────────────────────────────────────────────
    case "system": {
      if (message.subtype === "init") {
        return [{ type: "response.created", responseId: state.responseId }];
      }
      return [];
    }

    // ── 2-6. stream_event (Anthropic streaming API events) ───────────
    case "stream_event": {
      return mapStreamEvent(state, message);
    }

    // ── 7. assistant message complete ────────────────────────────────
    case "assistant": {
      const events: RuntimeEvent[] = [];

      // Capture the typed assistant error (e.g. "model_not_found") so the
      // terminal result mapper can render an actionable message. Since 0.3.144
      // the SDK reports model_not_found here when the selected model is
      // unavailable, instead of a generic invalid_request.
      if (typeof message.error === "string") {
        state.assistantError = message.error;
      }

      // Snapshot text fallback: only emit when stream_event/text_delta did NOT
      // already deliver this message's text. With includePartialMessages, the
      // SDK emits both incremental deltas AND a final assistant snapshot;
      // emitting both duplicates the reply.
      if (!state.assistantTextStreamed) {
        const assistantMessage = message.message as Record<string, unknown> | undefined;
        const content = assistantMessage?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
              const text = (block as Record<string, unknown>).text;
              if (typeof text === "string" && text) {
                events.push({
                  type: "response.output_text.delta",
                  responseId: state.responseId,
                  delta: text
                });
              }
            }
          }
        }
      }

      // Snapshot path for tool_use blocks: non-streaming consumers (E2B CLI
      // JSON path, or SDK calls without includePartialMessages) never see
      // stream_event/content_block_start. Extract the finalized tool_use
      // blocks straight from the assistant message so we still emit
      // tool.started with the full input.
      const assistantMessage = message.message as Record<string, unknown> | undefined;
      const content = assistantMessage?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const blockRecord = block as Record<string, unknown>;
          const blockType = blockRecord.type;
          const blockId = typeof blockRecord.id === "string" ? blockRecord.id : null;
          if (!blockId || state.pendingToolCalls.has(blockId)) continue;

          if (blockType === "tool_use") {
            events.push(recordPendingToolCall(state, blockRecord, "command"));
          } else if (blockType === "mcp_tool_use" || blockType === "server_tool_use") {
            events.push(recordPendingToolCall(state, blockRecord, "mcp"));
          }
        }
      }

      // Reset for the next assistant message in this turn (multi-step turns).
      state.assistantTextStreamed = false;
      events.push({ type: "response.output_item.done", responseId: state.responseId });
      return events;
    }

    // ── 7b. user message (carries tool_result blocks) ────────────────
    case "user": {
      return mapUserMessage(state, message);
    }

    // ── 8. tool progress ─────────────────────────────────────────────
    case "tool_progress": {
      const itemId = state.lastToolUseId ?? uuidv7();
      const raw = message.content ?? message.data ?? message.delta ?? "";
      const delta = typeof raw === "string" ? raw : JSON.stringify(raw);
      return [
        {
          type: "response.tool.output.delta",
          responseId: state.responseId,
          itemId,
          delta
        }
      ];
    }

    // ── 9-10. result ─────────────────────────────────────────────────
    case "result": {
      return mapResult(state, message);
    }

    default:
      return [];
  }
}

// ─── stream_event sub-dispatcher ─────────────────────────────────────────────

function mapStreamEvent(
  state: ClaudeEventMapperState,
  message: Record<string, unknown>
): RuntimeEvent[] {
  const event = message.event as Record<string, unknown> | undefined;
  if (!event) return [];

  const eventType = event.type as string | undefined;
  const index = typeof event.index === "number" ? event.index : null;

  switch (eventType) {
    case "content_block_delta": {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return [];

      const deltaType = delta.type as string | undefined;

      // 2. text delta → output_text.delta
      if (deltaType === "text_delta") {
        const text = delta.text;
        if (typeof text !== "string") return [];
        state.assistantTextStreamed = true;
        return [
          {
            type: "response.output_text.delta",
            responseId: state.responseId,
            delta: text
          }
        ];
      }

      // 3. thinking delta → reasoning_summary.delta
      if (deltaType === "thinking_delta") {
        const thinking = delta.thinking;
        if (typeof thinking !== "string") return [];
        return [
          {
            type: "framework:reasoning_summary.delta",
            responseId: state.responseId,
            delta: thinking
          }
        ];
      }

      // 6. input_json_delta — tool arguments are streamed as incremental JSON
      // fragments. Accumulate into the pending tool's input buffer so we can
      // reconstruct the full input on content_block_stop. No event is emitted
      // — the finalized input is delivered via a re-emitted tool.started when
      // the block closes, and again on tool.completed.
      if (deltaType === "input_json_delta") {
        const partial = delta.partial_json;
        if (typeof partial !== "string") return [];
        const toolUseId =
          (index !== null ? state.indexToToolUseId.get(index) : null) ?? state.lastToolUseId;
        if (!toolUseId) return [];
        const pending = state.pendingToolCalls.get(toolUseId);
        if (!pending) return [];
        pending.inputJsonBuffer += partial;
        return [];
      }

      return [];
    }

    case "content_block_start": {
      const contentBlock = event.content_block as Record<string, unknown> | undefined;
      if (!contentBlock) return [];

      const blockType = contentBlock.type as string | undefined;

      // 4. tool_use → tool.started (kind: "command")
      if (blockType === "tool_use") {
        return [recordPendingToolCall(state, contentBlock, "command", index)];
      }

      // 5. mcp_tool_use / server_tool_use → tool.started (kind: "mcp")
      if (blockType === "mcp_tool_use" || blockType === "server_tool_use") {
        return [recordPendingToolCall(state, contentBlock, "mcp", index)];
      }

      return [];
    }

    case "content_block_stop": {
      const toolUseId =
        (index !== null ? state.indexToToolUseId.get(index) : null) ?? state.lastToolUseId;
      if (!toolUseId) return [];
      const pending = state.pendingToolCalls.get(toolUseId);
      if (!pending) return [];

      if (pending.inputJsonBuffer) {
        pending.toolCall.input = pending.inputJsonBuffer;
        applyInputToToolCall(pending.toolCall);
      }
      // Re-emit tool.started with the finalized input so the UI shows
      // arguments while the tool is still running (before tool_result lands).
      return [
        {
          type: "response.tool.started",
          responseId: state.responseId,
          toolCall: cloneToolCall(pending.toolCall)
        }
      ];
    }

    default:
      return [];
  }
}

// ─── user message (tool_result) mapper ───────────────────────────────────────

function mapUserMessage(
  state: ClaudeEventMapperState,
  message: Record<string, unknown>
): RuntimeEvent[] {
  const userMessage = message.message as Record<string, unknown> | undefined;
  const content = userMessage?.content;
  if (!Array.isArray(content)) return [];

  const events: RuntimeEvent[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const blockRecord = block as Record<string, unknown>;
    if (blockRecord.type !== "tool_result") continue;

    const toolUseId = typeof blockRecord.tool_use_id === "string" ? blockRecord.tool_use_id : null;
    if (!toolUseId) continue;

    const pending = state.pendingToolCalls.get(toolUseId);
    if (!pending) continue;

    const isError = blockRecord.is_error === true;
    const output = extractToolResultText(blockRecord.content);
    const durationMs = Math.max(0, Date.now() - pending.startedAt);

    pending.toolCall.output = output;
    pending.toolCall.status = isError ? "failed" : "completed";
    pending.toolCall.durationMs = durationMs;

    events.push({
      type: "response.tool.completed",
      responseId: state.responseId,
      toolCall: cloneToolCall(pending.toolCall)
    });

    state.pendingToolCalls.delete(toolUseId);
    for (const [idx, id] of state.indexToToolUseId) {
      if (id === toolUseId) state.indexToToolUseId.delete(idx);
    }
  }

  return events;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "image") {
      // Claude may return images (e.g. screenshot tool). Surface a placeholder
      // rather than dumping base64 into the audit trail.
      parts.push("[image]");
    }
  }
  return parts.join("");
}

// ─── result mapper ───────────────────────────────────────────────────────────

function mapResult(
  state: ClaudeEventMapperState,
  message: Record<string, unknown>
): RuntimeEvent[] {
  const subtype = message.subtype as string | undefined;
  const doneEvent: RuntimeEvent = {
    type: "response.output_item.done",
    responseId: state.responseId
  };

  // Token usage is captured by the LLM proxy now (single source of truth,
  // sandbox-tamper-resistant). The SDK's usage in the result message is
  // ignored here.
  if (subtype === "success") {
    return [doneEvent, { type: "response.completed", responseId: state.responseId }];
  }

  // Stop button — Claude SDK emits a final result with subtype="interrupt"
  // after iterator.interrupt() resolves. Treat as a clean terminal so the
  // partial assistant text we already streamed lands as `interrupted` and
  // the user can immediately send a follow-up in the same warm session.
  if (subtype === "interrupt") {
    return [
      doneEvent,
      { type: "response.completed", responseId: state.responseId, interrupted: true }
    ];
  }

  // A configured model that doesn't exist / isn't available surfaces as
  // error="model_not_found" on the assistant message (SDK 0.3.144+). Turn it
  // into a tenant-actionable config error instead of an opaque API failure —
  // the model is set per-tenant (CLAUDE_CODE_MODEL / per-turn override), so a
  // bad value is a configuration mistake, not an outage.
  if (state.assistantError === "model_not_found") {
    return [
      doneEvent,
      {
        type: "response.failed",
        responseId: state.responseId,
        message:
          "The configured Claude model is not available (model_not_found). " +
          "Check the tenant's model setting."
      }
    ];
  }

  // Any other error subtype (error_during_execution, error_max_turns, …).
  // SDKResultError carries `errors: string[]`; older/loose shapes use
  // `error`/`message`. Prefer the typed assistant error when present.
  const errorsArray = Array.isArray(message.errors)
    ? (message.errors as unknown[]).filter((e): e is string => typeof e === "string")
    : [];
  const errorMessage =
    state.assistantError ??
    (errorsArray.length > 0
      ? errorsArray.join("; ")
      : typeof message.error === "string"
        ? message.error
        : typeof message.message === "string"
          ? message.message
          : subtype ?? "Unknown error");

  return [
    doneEvent,
    {
      type: "response.failed",
      responseId: state.responseId,
      message: errorMessage
    }
  ];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildToolCallFromContentBlock(
  block: Record<string, unknown>,
  kind: "command" | "mcp"
): RuntimeToolCall {
  const id = typeof block.id === "string" ? block.id : uuidv7();
  const name = typeof block.name === "string" ? block.name : null;
  const server = typeof block.server_name === "string" ? block.server_name : null;
  const input = block.input != null ? JSON.stringify(block.input) : "";

  const toolCall: RuntimeToolCall = {
    itemId: id,
    kind,
    title: name ? (kind === "mcp" ? `Tool: ${name}` : name) : (kind === "mcp" ? "MCP tool call" : "Tool call"),
    status: "in_progress",
    command: kind === "command" ? name : null,
    cwd: null,
    server: kind === "mcp" ? server : null,
    toolName: name,
    input,
    output: "",
    exitCode: null,
    durationMs: null
  };
  if (kind === "command") applyInputToToolCall(toolCall);
  return toolCall;
}

function cloneToolCall(toolCall: RuntimeToolCall): RuntimeToolCall {
  return { ...toolCall };
}

function recordPendingToolCall(
  state: ClaudeEventMapperState,
  contentBlock: Record<string, unknown>,
  kind: "command" | "mcp",
  index: number | null = null
): RuntimeEvent {
  const toolCall = buildToolCallFromContentBlock(contentBlock, kind);
  state.pendingToolCalls.set(toolCall.itemId, {
    toolCall,
    inputJsonBuffer: "",
    startedAt: Date.now()
  });
  if (index !== null) state.indexToToolUseId.set(index, toolCall.itemId);
  state.lastToolUseId = toolCall.itemId;
  return {
    type: "response.tool.started",
    responseId: state.responseId,
    toolCall: cloneToolCall(toolCall)
  };
}

// For Claude's native command-shaped tools (Bash, Shell, …) the shell command
// lives inside the JSON input as `command`. Surface it on toolCall.command so
// the UI shows the actual command line (matching the Codex rendering) rather
// than the generic tool name.
function applyInputToToolCall(toolCall: RuntimeToolCall): void {
  if (toolCall.kind !== "command" || !toolCall.input) return;
  const toolName = (toolCall.toolName ?? "").toLowerCase();
  if (toolName !== "bash" && toolName !== "shell") return;
  try {
    const parsed = JSON.parse(toolCall.input) as Record<string, unknown>;
    if (typeof parsed.command === "string" && parsed.command.trim()) {
      toolCall.command = parsed.command;
    }
  } catch {
    // Partial JSON during streaming — ignore.
  }
}

