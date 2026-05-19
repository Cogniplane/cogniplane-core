import type { Session } from "@cogniplane/shared-types";

export type SessionGroups = {
  pinned: Session[];
  today: Session[];
  earlier: Session[];
  improvement: Session[];
};

export function formatCompactTime(iso: string, now: number = Date.now()): string {
  const timestamp = new Date(iso).getTime();
  const diffMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));

  if (diffMinutes < 1) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  return `${diffDays}d`;
}

export function isToday(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function initialsOf(name: string | undefined, email: string | undefined): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function groupSessions(
  sessions: Session[],
  pinnedSessionIds: Set<string>,
  query: string,
  now: Date = new Date()
): SessionGroups {
  const q = query.trim().toLowerCase();
  const matches = (s: Session) => !q || s.sessionName.toLowerCase().includes(q);
  const groups: SessionGroups = { pinned: [], today: [], earlier: [], improvement: [] };
  for (const session of sessions) {
    if (!matches(session)) continue;
    if (session.purpose === "skill_improvement") {
      groups.improvement.push(session);
      continue;
    }
    if (pinnedSessionIds.has(session.sessionId)) {
      groups.pinned.push(session);
    } else if (isToday(session.updatedAt, now)) {
      groups.today.push(session);
    } else {
      groups.earlier.push(session);
    }
  }
  return groups;
}

export function totalGroupedCount(groups: SessionGroups): number {
  return groups.pinned.length + groups.today.length + groups.earlier.length + groups.improvement.length;
}
