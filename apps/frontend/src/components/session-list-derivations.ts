import type { Session } from "@cogniplane/shared-types";

export function deriveAttentionSessionIds(
  sessions: Session[],
  selectedSessionId: string | null,
  pendingApprovalCount: number
): Set<string> {
  const set = new Set<string>();
  for (const session of sessions) {
    if (session.hasPendingApprovals) set.add(session.sessionId);
  }
  if (selectedSessionId) {
    if (pendingApprovalCount > 0) {
      set.add(selectedSessionId);
    } else {
      set.delete(selectedSessionId);
    }
  }
  return set;
}

export function deriveStreamingSessionIds(
  sessions: Session[],
  inFlightStreamingSessionId: string | null
): Set<string> {
  const set = new Set<string>();
  for (const session of sessions) {
    if (session.isRunning) set.add(session.sessionId);
  }
  if (inFlightStreamingSessionId) {
    set.add(inFlightStreamingSessionId);
  }
  return set;
}
