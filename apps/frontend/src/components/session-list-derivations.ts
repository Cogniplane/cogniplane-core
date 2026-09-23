import type { Session } from "@cogniplane/shared-types";

export function deriveAttentionSessionIds(
  sessions: Session[],
  selectedSessionId: string | null,
  pendingApprovalCount: number,
  // True when the host's count is newer than the saved flag: the host streams
  // or polls the turn, or the list has not reloaded since the turn ended.
  // Otherwise an approval can appear in the list before the host sees it, so
  // the saved flag stays. The count changes only the selected session.
  hasFreshApprovalCount: boolean
): Set<string> {
  const set = new Set<string>();
  for (const session of sessions) {
    if (session.hasPendingApprovals) set.add(session.sessionId);
  }
  if (selectedSessionId) {
    if (pendingApprovalCount > 0) {
      set.add(selectedSessionId);
    } else if (hasFreshApprovalCount) {
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
