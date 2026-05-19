import type {
  RunLogEntry,
  RunProgressEvent
} from "../../../hooks/use-admin-skill-judge-data";

export function formatInterval(ms: number): string {
  if (ms >= 60 * 60_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)}s`;
}

export function describeProgress(event: RunProgressEvent): string {
  switch (event.kind) {
    case "tick_started":
      return event.tenantId
        ? `Started run (tenant=${event.tenantId}).`
        : "Started run.";
    case "eligible_found":
      return `Found ${event.count} eligible session${event.count === 1 ? "" : "s"}.`;
    case "submit_skipped_inflight_batches":
      return `Skipped submit pass — ${event.pendingBatchCount} batch(es) still pending from a prior run.`;
    case "session_claimed":
      return `Claimed session ${event.sessionId} (${event.provider}/${event.model}, ${event.mode}).`;
    case "session_skipped_no_skills":
      return `Skipped ${event.sessionId} — no skills were available in that session.`;
    case "session_completed":
      return `Done ${event.sessionId} — judged ${event.skillsJudged} skill(s), ${event.invokedCount} invoked.`;
    case "session_failed":
      return `Failed ${event.sessionId}: ${event.error}`;
    case "batch_submitted":
      return `Submitted batch ${event.batchId} (${event.sessionCount} session(s)) to ${event.provider}/${event.model}.`;
    case "tick_completed":
      return `Run finished in ${(event.durationMs / 1000).toFixed(1)}s.`;
  }
}

export function logTone(entry: RunLogEntry): "ok" | "warn" | "err" {
  if (entry.type === "error") return "err";
  if (entry.type === "done") return "ok";
  switch (entry.event.kind) {
    case "session_failed":
    case "submit_skipped_inflight_batches":
      return "warn";
    case "session_completed":
    case "tick_completed":
      return "ok";
    default:
      return "ok";
  }
}

export function describeLogEntry(entry: RunLogEntry): string {
  if (entry.type === "progress") return describeProgress(entry.event);
  if (entry.type === "error") return `✗ ${entry.message}`;
  return "✓ Stream closed.";
}
