import type { Message, Session } from "@cogniplane/shared-types";

export type SessionStatus = "approval" | "failed" | "running" | "ready";

export function resolveSessionStatus(signals: {
  pendingApproval?: boolean;
  failed?: boolean;
  running?: boolean;
}): SessionStatus {
  if (signals.pendingApproval) return "approval";
  if (signals.failed) return "failed";
  if (signals.running) return "running";
  return "ready";
}

export function formatTurnElapsed(startedAt: string, now: number): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return formatTurnDuration(Math.max(0, now - start));
}

export function formatTurnDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export type LiveTurnActivity = {
  startedAt: string;
  isRunning: boolean;
  failed: boolean;
  turnId?: string;
  turnSequence?: number;
};

export function applyLiveTurn(session: Session, activity: LiveTurnActivity): { session: Session; applied: boolean } {
  // Both sequences come from persisted assistant rows. Browser clocks only
  // drive the timer and never decide which turn is newer.
  const serverSequence = session.latestTurnSequence;
  if (!activity.isRunning && (
    (serverSequence !== undefined && activity.turnSequence !== undefined && serverSequence > activity.turnSequence) ||
    (activity.turnSequence === undefined && session.isRunning)
  )) {
    return { session, applied: false };
  }
  return {
    session: {
      ...session,
      isRunning: activity.isRunning,
      hasTurnFailed: activity.failed,
      activeTurnStartedAt: activity.isRunning ? activity.startedAt : undefined
    },
    applied: true
  };
}

export type CompletedTurn = { durationMs: number; status: "completed" | "error" | "interrupted" };

export function latestCompletedTurn(
  messages: Message[], session: Session | null | undefined, activity: LiveTurnActivity | null
): CompletedTurn | undefined {
  if (!session || session.isRunning || activity?.isRunning) return undefined;
  const latest = [...messages].reverse().find((message) => message.sessionId === session.sessionId);
  if (!latest || latest.role !== "assistant") return undefined;
  // A completion refresh or session poll may still contain the preceding turn.
  if (activity && (!activity.turnId || activity.turnId !== latest.messageId)) return undefined;
  if (!activity && session.latestTurnId && session.latestTurnId !== latest.messageId) return undefined;
  if (latest.status !== "completed" && latest.status !== "error" && latest.status !== "interrupted") return undefined;
  if (typeof latest.durationMs !== "number" || formatTurnDuration(latest.durationMs) === null) return undefined;
  return { durationMs: latest.durationMs, status: latest.status };
}
