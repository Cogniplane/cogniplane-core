// Saved session history as AG-UI messages and state.
//
// `GET /sessions/:id/connect` sends this conversion to the browser. CopilotKit
// then restores the chat through its own connection path. The converter makes
// the same message shapes that @ag-ui/client's event reducer makes from a live
// stream, so the chat renders a saved turn in the same way as a live turn:
//   • reasoning   → a `reasoning`-role message (the thinking block)
//   • assistant   → text and `toolCalls[]` (the tool card renderer keys on these)
//   • tool result → a `tool`-role message with the same toolCallId (the result
//                   half of the card)
//
// A turn interleaves text, reasoning, and tool calls (text, tool, more text,
// tool, final text). Each tool result carries `textOffset`, and each reasoning
// segment `offset`: the character length of the assistant text when it
// started. The converter splits `content` at those offsets and puts the
// segments, reasoning blocks, and cards in that order, as they appeared live.
//
// The converter reads only the current history format (sessions.
// transcript_format). The routes do not send an older session here.

import { EventType, type BaseEvent, type Message as AguiMessage } from "@ag-ui/client";
import type { CustomEventValue } from "@cogniplane/shared-types";

import { customEvent } from "./deep-agents/agui-events.js";

type HistoryToolResult = {
  toolResultId: string;
  toolName: string | null;
  title: string;
  status: "in_progress" | "completed" | "failed" | "declined";
  input: string;
  output: string;
  textOffset?: number | null;
};

type HistoryReasoningSegment = { offset: number; text: string };

/** The saved message fields that the conversion reads. */
export type HistoryMessage = {
  messageId: string;
  role: "user" | "assistant" | "system";
  status: "pending" | "streaming" | "completed" | "error" | "interrupted";
  content: string;
  reasoningSegments?: HistoryReasoningSegment[] | null;
  planContent?: string;
  detail?: { pii?: { status?: string } };
  toolResults?: HistoryToolResult[];
};

export function toAguiMessages(messages: HistoryMessage[]): AguiMessage[] {
  const converted: AguiMessage[] = [];
  for (const message of messages) {
    // A PII-blocked turn saves only a `system` row (no user or assistant row).
    // The live stream shows the block text as an assistant message
    // (respondWithPiiBlock), so history shows the same assistant message.
    // The raw prompt is never saved, so nothing sensitive leaks.
    if (message.role === "system") {
      if (message.detail?.pii?.status === "blocked" && message.content) {
        converted.push({ id: message.messageId, role: "assistant", content: message.content });
      }
      continue;
    }

    if (message.role === "user") {
      if (!message.content) continue;
      converted.push({ id: message.messageId, role: "user", content: message.content });
      continue;
    }

    const reasoningSegments = message.reasoningSegments ?? [];
    const toolResults = message.toolResults ?? [];
    if (!message.content && reasoningSegments.length === 0 && toolResults.length === 0) continue;

    converted.push(...interleaveAssistantTurn(message.messageId, message.content, toolResults, reasoningSegments));
  }
  return converted;
}

// A reasoning burst as an AG-UI `reasoning`-role message (the thinking block).
function reasoningMessage(messageId: string, index: number, text: string): AguiMessage {
  return { id: `${messageId}:reasoning:${index}`, role: "reasoning", content: text };
}

// The `tool`-role result message for one tool call.
function toolResultMessage(tr: HistoryToolResult): AguiMessage {
  return {
    id: `${tr.toolResultId}:result`,
    role: "tool",
    toolCallId: tr.toolResultId,
    content: tr.output,
    // A tool still "in_progress" in history never returned: the turn stopped
    // during the call. Mark it interrupted, so it does not look like a
    // successful call with empty output.
    ...(tr.status === "failed" || tr.status === "declined"
      ? { error: tr.status }
      : tr.status === "in_progress"
        ? { error: "interrupted" }
        : {})
  };
}

function toolCall(tr: HistoryToolResult) {
  return {
    id: tr.toolResultId,
    type: "function" as const,
    function: { name: tr.toolName ?? tr.title, arguments: tr.input || "{}" }
  };
}

function interleaveAssistantTurn(
  messageId: string,
  content: string,
  toolResults: HistoryToolResult[],
  segments: HistoryReasoningSegment[]
): AguiMessage[] {
  // A reply with only text: one assistant message with the saved row id.
  if (toolResults.length === 0 && segments.length === 0) {
    return [{ id: messageId, role: "assistant", content }];
  }

  // Merge reasoning bursts and tool calls into one list ordered by their
  // offset into the assistant text. Then walk the content and put the text
  // segment before each insertion. At an equal offset, reasoning comes before
  // the tool: live, the burst closed before the tool call started.
  const out: AguiMessage[] = [];
  type Insertion =
    | { kind: "reasoning"; offset: number; index: number; text: string }
    | { kind: "tool"; offset: number; index: number; tr: HistoryToolResult };
  const rank = (kind: Insertion["kind"]) => (kind === "reasoning" ? 0 : 1);
  const insertions: Insertion[] = [
    ...segments.map((seg, index) => ({ kind: "reasoning" as const, offset: seg.offset, index, text: seg.text })),
    ...toolResults.map((tr, index) => ({ kind: "tool" as const, offset: tr.textOffset ?? 0, index, tr }))
  ].sort((a, b) => a.offset - b.offset || rank(a.kind) - rank(b.kind));

  let cursor = 0;
  for (const insertion of insertions) {
    const offset = Math.max(cursor, Math.min(insertion.offset, content.length));
    const segment = content.slice(cursor, offset);
    if (segment.trim()) out.push({ id: `${messageId}:text:${cursor}`, role: "assistant", content: segment });
    cursor = offset;
    if (insertion.kind === "reasoning") {
      out.push(reasoningMessage(messageId, insertion.index, insertion.text));
    } else {
      out.push(
        { id: `${messageId}:call:${insertion.index}`, role: "assistant", toolCalls: [toolCall(insertion.tr)] },
        toolResultMessage(insertion.tr)
      );
    }
  }
  const tail = content.slice(cursor);
  if (tail.trim()) out.push({ id: `${messageId}:text:tail`, role: "assistant", content: tail });
  return out;
}

/** True when a row after the newest user message adds something to the
 *  converted history: text, reasoning, a tool call, or a plan. A turn saves
 *  its prompt before its reply row, so such a row can be the reply of the
 *  turn that runs now. A reply row that the turn only created adds nothing. */
export function hasReplyAfterLastPrompt(messages: HistoryMessage[]): boolean {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role !== "user") start -= 1;
  const after = messages.slice(start);
  return toAguiMessages(after).length > 0 || after.some((message) => Boolean(message.planContent?.trim()));
}

// The plan (write_todos) is agent state at `/plan`, not a message. A live turn
// changes it through STATE_DELTA. History takes the plan of the most recent
// assistant turn that saved one. An empty string means no plan.
export function planStateFromMessages(messages: HistoryMessage[]): { plan: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const plan = messages[index]?.planContent?.trim();
    if (plan) return { plan };
  }
  return { plan: "" };
}

/** The finished run that carries the saved history. @ag-ui/client accepts
 *  snapshots only inside a run. RUN_STARTED has no `input.messages`: the
 *  reducer would add those messages again. The browser agent makes this
 *  snapshot replace its transcript. */
export function historyRunEvents(input: {
  threadId: string;
  runId: string;
  messages: HistoryMessage[];
  connection: CustomEventValue<"session_connection">;
}): BaseEvent[] {
  const { threadId, runId } = input;
  return [
    { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
    { type: EventType.MESSAGES_SNAPSHOT, messages: toAguiMessages(input.messages) } as BaseEvent,
    { type: EventType.STATE_SNAPSHOT, snapshot: planStateFromMessages(input.messages) } as BaseEvent,
    customEvent("session_connection", input.connection),
    { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent
  ];
}
