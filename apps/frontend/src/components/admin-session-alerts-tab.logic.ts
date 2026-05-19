import { summarizePiiRun } from "../lib/admin-session-pii-utils";
import type {
  AdminSessionDetailApproval,
  AdminSessionDetailMessage,
  AdminSessionDetailPiiRun
} from "@cogniplane/shared-types";

export type AlertItem = {
  id: string;
  timestamp: string;
  kind: "pii" | "approval" | "error";
  iconColor: "red" | "blue" | "gray";
  iconLabel: string;
  summary: string;
  jumpToMessageId: string | null;
};

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Pull the canonical scanRunId out of a message's detail_json, if present.
 * The message records its own scan via `detailJson.pii.scanRunId` — that's
 * the link we use to jump from a PII alert back to the originating message
 * even when the scan's subjectId predates the message.
 */
export function readPiiScanRunId(detailJson: unknown): string | null {
  if (!detailJson || typeof detailJson !== "object") return null;
  const pii = (detailJson as Record<string, unknown>).pii;
  if (!pii || typeof pii !== "object") return null;
  const id = (pii as Record<string, unknown>).scanRunId;
  return typeof id === "string" ? id : null;
}

export function buildPiiAlertItem(
  run: AdminSessionDetailPiiRun,
  messageIdByScanRunId: Map<string, string>
): AlertItem {
  // For message-bound PII, prefer the messageId resolved via detail_json.pii.scanRunId
  // (canonical link). Fall back to subjectId only when subjectType === "message" and
  // the scan was run after the message id existed.
  const messageIdFromScan = messageIdByScanRunId.get(run.scanRunId) ?? null;
  const linkedMessageId =
    messageIdFromScan ?? (run.subjectType === "message" ? run.subjectId : null);
  const targetLabel = linkedMessageId
    ? `on message ${shortId(linkedMessageId)}`
    : run.subjectType === "artifact"
      ? `on artifact ${shortId(run.subjectId)}`
      : "on session";
  const color: AlertItem["iconColor"] =
    run.status === "blocked" ? "red" : run.status === "transformed" ? "blue" : "gray";
  return {
    id: `pii-${run.scanRunId}`,
    timestamp: run.createdAt,
    kind: "pii",
    iconColor: color,
    iconLabel: `PII ${run.status}`,
    summary: `PII ${run.status} ${targetLabel}: ${summarizePiiRun(run)}`,
    jumpToMessageId: linkedMessageId
  };
}

export function buildApprovalAlertItem(approval: AdminSessionDetailApproval): AlertItem {
  const decisionPart = approval.decision ? ` (${approval.decision})` : "";
  const color: AlertItem["iconColor"] =
    approval.status === "rejected" ? "red" : approval.status === "pending" ? "blue" : "gray";
  return {
    id: `approval-${approval.approvalId}`,
    timestamp: approval.createdAt,
    kind: "approval",
    iconColor: color,
    iconLabel: `Approval ${approval.status}`,
    summary: `Approval ${approval.status}${decisionPart} — ${approval.title}`,
    jumpToMessageId: null
  };
}

export function buildErrorAlertItem(message: AdminSessionDetailMessage): AlertItem {
  const trimmedContent = message.contentText.trim();
  const detail = trimmedContent ? trimmedContent.slice(0, 80) : message.status;
  return {
    id: `error-${message.messageId}`,
    timestamp: message.createdAt,
    kind: "error",
    iconColor: "red",
    iconLabel: "Error",
    summary: `Message error (${message.role}): ${detail}`,
    jumpToMessageId: message.messageId
  };
}

/**
 * Build the unified, time-ordered alert list shown in the alerts tab.
 * Combines PII runs, approvals, and errored messages into one stream
 * sorted ascending by createdAt. Errored-message detection is hard-coded
 * to status `failed` or `error`.
 */
export function buildAlertItems(input: {
  messages: AdminSessionDetailMessage[];
  approvals: AdminSessionDetailApproval[];
  piiRuns: AdminSessionDetailPiiRun[];
}): AlertItem[] {
  const messageIdByScanRunId = new Map<string, string>();
  for (const message of input.messages) {
    const scanId = readPiiScanRunId(message.detailJson);
    if (scanId) messageIdByScanRunId.set(scanId, message.messageId);
  }

  return [
    ...input.piiRuns.map((run) => buildPiiAlertItem(run, messageIdByScanRunId)),
    ...input.approvals.map(buildApprovalAlertItem),
    ...input.messages
      .filter((m) => m.status === "failed" || m.status === "error")
      .map(buildErrorAlertItem)
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
