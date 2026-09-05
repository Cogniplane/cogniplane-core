import type { Message as AGUIMessage } from "@ag-ui/client";
import type { Message, ReasoningSegment, ToolResult } from "@cogniplane/shared-types";
import type { ToolStatusRow } from "./chat-cards/chat-cards.types";

// Map persisted history → AG-UI messages to seed CopilotChat on reload / session
// switch. Reconstructs the SAME message shapes the live AG-UI stream produces via
// @ag-ui/client's event→message reducer, so CopilotChat's native renderers light
// up on reload exactly as they do live:
//   • reasoning  → a `reasoning`-role message (rendered as the thinking block)
//   • assistant  → text + `toolCalls[]` (the function-call parts the tool card
//                  renderer, useDefaultTool, keys on)
//   • tool result→ a companion `tool`-role message keyed by toolCallId (the card's
//                  `result` half)
//
// A turn interleaves text and tool calls (text, tool, more text, tool, final
// text). Each tool result carries `textOffset` = the character length of the
// assistant text when that call started, so we split `content` at those offsets
// and emit the segments and cards in order, matching the live layout. When a turn
// has no offsets (legacy rows), we fall back to all-text-then-all-tools.
// Remove this fallback only after retained tool results all have textOffset,
// through a verified backfill or deletion of the affected conversation history.
export function toAguiInitialMessages(messages: Message[]): AGUIMessage[] {
  const seeded: AGUIMessage[] = [];
  for (const message of messages) {
    // A PII-blocked turn persists only a `system` row (no user/assistant row).
    // The live AG-UI stream renders the block copy as an assistant text message
    // (respondWithPiiBlock), so seed the SAME assistant bubble on reload —
    // otherwise the notice shows live and then vanishes on refresh/session
    // switch. The raw prompt is never persisted, so nothing sensitive leaks.
    if (message.role === "system") {
      const pii = (message as { detail?: { pii?: { status?: string } } }).detail?.pii;
      if (pii?.status === "blocked" && message.content) {
        seeded.push({ id: message.messageId, role: "assistant", content: message.content });
      }
      continue;
    }

    if (message.role !== "user" && message.role !== "assistant") continue;

    if (message.role === "user") {
      if (!message.content) continue;
      seeded.push({ id: message.messageId, role: "user", content: message.content });
      continue;
    }

    const reasoning = message.reasoningContent?.trim();
    const reasoningSegments = message.reasoningSegments ?? null;
    const toolResults = message.toolResults ?? [];
    if (!message.content && !reasoning && toolResults.length === 0) continue;

    // Positioned reasoning bursts interleave with the turn body (below). Only
    // when segments are absent on legacy rows do we fall back to the
    // single reasoning block rendered ahead of the body. Remove this branch only
    // after retained rows with reasoningContent have reasoningSegments populated
    // by a verified backfill, or those conversations have been deleted.
    if (!reasoningSegments && reasoning) {
      seeded.push({
        id: `${message.messageId}:reasoning`,
        role: "reasoning",
        content: reasoning
      });
    }

    seeded.push(
      ...interleaveAssistantTurn(
        message.messageId,
        message.content ?? "",
        toolResults,
        reasoningSegments
      )
    );
  }
  return seeded;
}

// A reasoning burst as an AG-UI `reasoning`-role message (the thinking block).
function reasoningMessage(messageId: string, index: number, text: string): AGUIMessage {
  return { id: `${messageId}:reasoning:${index}`, role: "reasoning", content: text };
}

// The companion `tool`-role result message for one tool call. Shared by the
// interleaved and fallback paths so their result shape can't drift.
function toolResultMessage(tr: ToolResult): AGUIMessage {
  return {
    id: `${tr.toolResultId}:result`,
    role: "tool",
    toolCallId: tr.toolResultId,
    content: tr.output,
    // A tool still "in_progress" on reload never returned — the turn was
    // aborted mid-call. Surface it as interrupted so it doesn't render as a
    // clean success with empty output.
    ...(tr.status === "failed" || tr.status === "declined"
      ? { error: tr.status }
      : tr.status === "in_progress"
        ? { error: "interrupted" }
        : {})
  };
}

// One tool call → its assistant `toolCalls[]` entry + the companion `tool`
// result message. Extracted so both interleaved and fallback paths agree.
function toolCallMessages(tr: ToolResult, assistantId: string): AGUIMessage[] {
  return [
    {
      id: assistantId,
      role: "assistant",
      toolCalls: [
        {
          id: tr.toolResultId,
          type: "function" as const,
          function: { name: tr.toolName ?? tr.title, arguments: tr.input || "{}" }
        }
      ]
    },
    toolResultMessage(tr)
  ];
}

function interleaveAssistantTurn(
  messageId: string,
  content: string,
  toolResults: ToolResult[],
  reasoningSegments: ReasoningSegment[] | null
): AGUIMessage[] {
  const out: AGUIMessage[] = [];
  const segments = reasoningSegments ?? [];

  // Legacy / offset-less turn: keep the original single-message shape — all text
  // on one assistant message with every tool call, then the results. Reasoning
  // (if any) was already emitted as the single block ahead of this by the caller.
  const hasOffsets = toolResults.some((tr) => tr.textOffset != null);
  if ((toolResults.length === 0 || !hasOffsets) && segments.length === 0) {
    out.push({
      id: messageId,
      role: "assistant",
      ...(content ? { content } : {}),
      ...(toolResults.length
        ? {
            toolCalls: toolResults.map((tr) => ({
              id: tr.toolResultId,
              type: "function" as const,
              function: { name: tr.toolName ?? tr.title, arguments: tr.input || "{}" }
            }))
          }
        : {})
    });
    for (const tr of toolResults) {
      out.push(toolResultMessage(tr));
    }
    return out;
  }

  // Interleaved turn: merge reasoning bursts and tool calls into one list keyed
  // by their offset into the assistant text, then walk the content emitting the
  // text segment before each insertion. At an equal offset reasoning precedes
  // the tool (live, a burst is what closed before the tool call started), so
  // sort reasoning ahead of tools on a tie.
  type Insertion =
    | { kind: "reasoning"; offset: number; index: number; text: string }
    | { kind: "tool"; offset: number; index: number; tr: ToolResult };
  const rank = (kind: Insertion["kind"]) => (kind === "reasoning" ? 0 : 1);
  const insertions: Insertion[] = [
    ...segments.map((seg, index) => ({
      kind: "reasoning" as const,
      offset: seg.offset,
      index,
      text: seg.text
    })),
    ...toolResults.map((tr, index) => ({
      kind: "tool" as const,
      offset: tr.textOffset ?? 0,
      index,
      tr
    }))
  ].sort((a, b) => a.offset - b.offset || rank(a.kind) - rank(b.kind));

  let cursor = 0;
  insertions.forEach((insertion) => {
    const offset = Math.max(cursor, Math.min(insertion.offset, content.length));
    const segment = content.slice(cursor, offset);
    if (segment.trim()) {
      out.push({ id: `${messageId}:text:${cursor}`, role: "assistant", content: segment });
    }
    cursor = offset;
    if (insertion.kind === "reasoning") {
      out.push(reasoningMessage(messageId, insertion.index, insertion.text));
    } else {
      out.push(...toolCallMessages(insertion.tr, `${messageId}:call:${insertion.index}`));
    }
  });
  const tail = content.slice(cursor);
  if (tail.trim()) {
    out.push({ id: `${messageId}:text:tail`, role: "assistant", content: tail });
  }
  return out;
}

// Seed the failed/declined tool-status side-channel from persisted history.
//
// CopilotKit's native tool card derives its status purely from the presence of a
// matching tool-result message — it never reads the `error` field we set in
// toolCallMessages — so on reload a failed or declined call renders identically
// to a success. The live turn surfaces failure through a `tool_status` CUSTOM
// event that populates `toolStatuses` (rendered by ToolStatusRowView); reload has
// no event stream, so we reconstruct the SAME rows from the persisted results.
// Mirrors the `tool_status` case in use-agui-custom-events.ts. Only failed/
// declined are surfaced (matching the live wire); `in_progress` is already shown
// as "interrupted" via the seeded tool message's `error` field.
export function toolStatusesFromMessages(messages: Message[]): ToolStatusRow[] {
  const rows: ToolStatusRow[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const tr of message.toolResults ?? []) {
      if (tr.status !== "failed" && tr.status !== "declined") continue;
      rows.push({
        type: "tool-status",
        rowId: `tool:${tr.toolResultId}`,
        toolCallId: tr.toolResultId,
        toolName: tr.toolName ?? tr.title ?? "tool",
        status: tr.status,
        server: tr.server ?? null,
        durationMs: tr.durationMs ?? null
      });
    }
  }
  return rows;
}

// The plan pane (write_todos) rides agent STATE as `/plan`, not a message — on a
// live turn it arrives via STATE_DELTA and useCoAgentStateRender renders it.
// Reload has no delta stream, so seed the agent's initialState from the most
// recent assistant turn that persisted plan markdown. Empty string → no pane.
export function planStateFromMessages(messages: Message[]): { plan: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const plan = messages[index]?.planContent?.trim();
    if (plan) return { plan };
  }
  return { plan: "" };
}
