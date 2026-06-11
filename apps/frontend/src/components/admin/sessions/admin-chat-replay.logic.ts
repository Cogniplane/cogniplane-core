import type {
  AdminSessionDetailMessage,
  AdminSessionDetailPiiRun
} from "@cogniplane/shared-types";

/**
 * Pull the canonical scanRunId out of a message's detail_json, if present.
 * Mirrors the shape used by the alerts tab — keeping the helpers symmetric
 * lets both views resolve message↔scan links through the same path.
 */
export function readPiiScanRunId(detailJson: unknown): string | null {
  if (!detailJson || typeof detailJson !== "object") return null;
  const pii = (detailJson as Record<string, unknown>).pii;
  if (!pii || typeof pii !== "object") return null;
  const id = (pii as Record<string, unknown>).scanRunId;
  return typeof id === "string" ? id : null;
}

export type PiiRunIndex = {
  byScanId: Map<string, AdminSessionDetailPiiRun>;
  byMessageId: Map<string, AdminSessionDetailPiiRun[]>;
};

/**
 * Two paths to attach a PII run to a message:
 *   (a) pii_scan_runs.subject_id directly equals the message id (rare —
 *       messages-pii-handler runs before the message exists, so it stores
 *       the session id in subject_id and threads the scanRunId through
 *       messages.detail_json.pii.scanRunId);
 *   (b) lookup by scanRunId from the message's detailJson, which is the
 *       canonical link for inline PII runs.
 *
 * Build both indices in one pass so each per-message lookup stays O(1).
 */
export function indexPiiRuns(piiRuns: AdminSessionDetailPiiRun[]): PiiRunIndex {
  const byScanId = new Map<string, AdminSessionDetailPiiRun>();
  const byMessageId = new Map<string, AdminSessionDetailPiiRun[]>();
  for (const run of piiRuns) {
    byScanId.set(run.scanRunId, run);
    if (run.subjectType === "message") {
      const list = byMessageId.get(run.subjectId) ?? [];
      list.push(run);
      byMessageId.set(run.subjectId, list);
    }
  }
  return { byScanId, byMessageId };
}

/**
 * Resolve the PII runs to display alongside a single message. Combines the
 * direct subject-id matches with the canonical-scanRunId match, deduping
 * so the same run isn't shown twice.
 */
export function piiRunsForMessage(
  index: PiiRunIndex,
  message: AdminSessionDetailMessage
): AdminSessionDetailPiiRun[] {
  const direct = index.byMessageId.get(message.messageId) ?? [];
  const linkedId = readPiiScanRunId(message.detailJson);
  const linked = linkedId ? index.byScanId.get(linkedId) : undefined;
  if (!linked) return direct;
  if (direct.some((r) => r.scanRunId === linked.scanRunId)) return direct;
  return [...direct, linked];
}

/**
 * Map a backend message status to the visual class fragment used by the
 * card. Live chat normalizes to: pending | streaming | completed | error.
 * Anything else (`failed` from older shapes; truly unknown values) is
 * coerced to `completed` so the layout doesn't break.
 */
export function chatReplayStatusClass(status: string): string {
  if (status === "failed") return "error";
  if (
    status === "pending" ||
    status === "streaming" ||
    status === "completed" ||
    status === "error"
  ) {
    return status;
  }
  return "completed";
}
