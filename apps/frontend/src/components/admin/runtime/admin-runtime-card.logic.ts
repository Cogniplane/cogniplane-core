import type { RuntimeSessionSummary } from "@cogniplane/shared-types";

export type RuntimeStatusFilter = "all" | "active" | "stopped";

/**
 * Filter runtime sessions by free-text search against sessionId + runtimeId
 * and a coarse status bucket. The status bucket maps `stopped` to its
 * literal value and lumps every non-stopped state into `active` — the UI
 * only needs to triage live vs. drained sessions, not enumerate every
 * backend phase.
 */
export function filterRuntimeSessions(
  sessions: RuntimeSessionSummary[],
  search: string,
  statusFilter: RuntimeStatusFilter
): RuntimeSessionSummary[] {
  const q = search.toLowerCase();
  return sessions.filter((s) => {
    const matchesSearch =
      q === "" ||
      s.sessionId.toLowerCase().includes(q) ||
      s.runtimeId.toLowerCase().includes(q);
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && s.status !== "stopped") ||
      (statusFilter === "stopped" && s.status === "stopped");
    return matchesSearch && matchesStatus;
  });
}

/** Number of sessions whose status is not `stopped`. */
export function countActiveSessions(sessions: RuntimeSessionSummary[]): number {
  return sessions.filter((s) => s.status !== "stopped").length;
}

/** Format a nullable ISO timestamp using en-CA medium date / short time. */
export function formatRuntimeTimestamp(value: string | null): string {
  if (!value) return "n/a";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
