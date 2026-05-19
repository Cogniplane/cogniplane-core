import type {
  AdminSessionDetailMessageToolResult,
  AdminSessionDetailToolEvent
} from "@cogniplane/shared-types";

export type UnifiedRow =
  | {
      source: "event";
      key: string;
      title: string;
      kind: string;
      createdAt: string;
      durationMs: number | null;
      data: AdminSessionDetailToolEvent;
    }
  | {
      source: "result";
      key: string;
      title: string;
      kind: string;
      createdAt: string;
      durationMs: number | null;
      data: AdminSessionDetailMessageToolResult;
    };

/**
 * Merge tool events (Codex turn-loop signals) and message tool results
 * (per-message redacted payloads) into a single time-ordered list. Two
 * sources, one timeline. Sort by createdAt ascending so the operator
 * reads top-down chronologically.
 */
export function buildToolRows(
  toolEvents: AdminSessionDetailToolEvent[],
  toolResults: AdminSessionDetailMessageToolResult[]
): UnifiedRow[] {
  const rows: UnifiedRow[] = [
    ...toolEvents.map(
      (evt, idx): UnifiedRow => ({
        source: "event",
        key: `event-${evt.toolCallId}-${idx}`,
        title: evt.title,
        kind: evt.kind,
        createdAt: evt.createdAt,
        durationMs: evt.durationMs,
        data: evt
      })
    ),
    ...toolResults.map(
      (tr): UnifiedRow => ({
        source: "result",
        key: `result-${tr.toolResultId}`,
        title: tr.title || tr.toolName || tr.commandText || "tool",
        kind: tr.kind,
        createdAt: tr.createdAt,
        durationMs: tr.durationMs,
        data: tr
      })
    )
  ];
  rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return rows;
}

/** Format an ISO timestamp for the tool row header. */
export function formatToolTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Pretty-print a duration in ms — sub-second as "Xms", else "X.XXs". */
export function formatToolDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
