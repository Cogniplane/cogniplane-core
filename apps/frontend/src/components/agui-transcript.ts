// Side state from saved history: MCP apps, tool failures, and runtime notices.
// The transcript itself comes from the session connection, which the backend
// converts (services/agui-history.ts).
import { CogniplaneCustomEventSchema, TurnStopReasonSchema, type McpAppCall, type Message, type TurnStopReason } from "@cogniplane/shared-types";
import type { RuntimeNoticeRow, ToolStatusRow } from "./chat-cards/chat-cards.types";

export function mcpAppsFromMessages(messages: Message[]): Record<string, McpAppCall> {
  const apps: Record<string, McpAppCall> = {};
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const tool of message.toolResults ?? []) {
      if (tool.status === "completed" && tool.mcpApp) apps[tool.toolResultId] = tool.mcpApp;
    }
  }
  return apps;
}
// Seed the failed/declined tool-status side-channel from saved history.
//
// The live turn reports a failure through a `tool_status` CUSTOM event, which
// adds a row to `toolStatuses` (rendered by ToolStatusRowView). Saved history
// has no such events, so this rebuilds the same rows from the saved results.
// Mirrors the `tool_status` case in use-agui-custom-events.ts. Only failed and
// declined calls get a row, as on the live wire. The tool card also shows
// these outcomes, and an `in_progress` call as interrupted, from the `error`
// of the saved tool message.
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

type RuntimeNoticeValue = Omit<RuntimeNoticeRow, "type" | "rowId">;

export function runtimeNoticeRow(notice: RuntimeNoticeValue): RuntimeNoticeRow {
  return {
    type: "runtime-notice",
    rowId: `notice:${notice.noticeId}`,
    noticeId: notice.noticeId,
    level: notice.level,
    title: notice.title,
    message: notice.message,
    createdAt: notice.createdAt
  };
}

const TURN_STOPPED_TEXT: Record<TurnStopReason, string> = {
  security_change: "This turn stopped because your account's security settings changed. Send the message again.",
  tool_context_ended: "This turn stopped because its tool access ended. Send the message again."
};

/**
 * The notice for a turn that the backend stopped, by its stop reason. One id
 * per turn (the assistant message id is the run id), so the live event and
 * the saved row show one notice.
 */
export function turnStoppedNotice(turnId: string, reason: TurnStopReason, createdAt: string): RuntimeNoticeRow {
  return runtimeNoticeRow({
    noticeId: `turn-stopped:${turnId}`,
    level: "warning",
    title: "Turn stopped",
    message: TURN_STOPPED_TEXT[reason],
    createdAt
  });
}

/** The stop reason of an interrupted RUN_FINISHED result, if it has a known one. */
export function turnStopReasonOfResult(result: unknown): TurnStopReason | null {
  if (!result || typeof result !== "object" || (result as { interrupted?: unknown }).interrupted !== true) return null;
  const parsed = TurnStopReasonSchema.safeParse((result as { reason?: unknown }).reason);
  return parsed.success ? parsed.data : null;
}

// The backend saves each `runtime_notice` event value in the assistant row's
// `detail.runtimeNotices`. `detail` is untyped JSON, so each entry goes through
// the live event schema. An entry that fails it is not shown. The first entry
// for a noticeId wins. An interrupted turn that the backend stopped also gets
// its stop notice (turnStoppedNotice).
export function runtimeNoticesFromMessages(messages: Message[]): RuntimeNoticeRow[] {
  const rows = new Map<string, RuntimeNoticeRow>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const reason = message.status === "interrupted" ? TurnStopReasonSchema.safeParse(message.stopReason) : null;
    if (reason?.success) {
      const notice = turnStoppedNotice(message.messageId, reason.data, message.updatedAt);
      rows.set(notice.noticeId, notice);
    }
    const saved = (message as { detail?: { runtimeNotices?: unknown } }).detail?.runtimeNotices;
    if (!Array.isArray(saved)) continue;
    for (const value of saved) {
      const parsed = CogniplaneCustomEventSchema.safeParse({ name: "runtime_notice", value });
      if (!parsed.success || parsed.data.name !== "runtime_notice") continue;
      if (!rows.has(parsed.data.value.noticeId)) rows.set(parsed.data.value.noticeId, runtimeNoticeRow(parsed.data.value));
    }
  }
  return [...rows.values()];
}
