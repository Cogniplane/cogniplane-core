import type { RuntimeSessionSummary } from "@cogniplane/shared-types";

export type RuntimeStatusFilter = "all" | "active" | "terminated" | "error" | "other";

// Only the literal current status is counted as active. Unknown or legacy
// values remain visible under Other states and never imply a live runtime.
export function runtimeStatusBucket(status: string): Exclude<RuntimeStatusFilter, "all"> {
  return status === "active" || status === "terminated" || status === "error" ? status : "other";
}

export function filterRuntimeSessions(
  sessions: RuntimeSessionSummary[], search: string, statusFilter: RuntimeStatusFilter
): RuntimeSessionSummary[] {
  const q = search.trim().toLowerCase();
  return sessions.filter(s =>
    (!q || s.sessionId.toLowerCase().includes(q) || s.runtimeId.toLowerCase().includes(q)) &&
    (statusFilter === "all" || runtimeStatusBucket(s.status) === statusFilter));
}

export function countActiveSessions(sessions: RuntimeSessionSummary[]): number {
  return sessions.filter(s => runtimeStatusBucket(s.status) === "active").length;
}

export function formatRuntimeTimestamp(value: string | null): string {
  if (!value) return "Unavailable";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
