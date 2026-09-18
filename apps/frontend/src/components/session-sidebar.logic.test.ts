import { describe, expect, test } from "vitest";
import type { Session } from "@cogniplane/shared-types";

import {
  formatCompactTime,
  groupSessions,
  initialsOf,
  isToday,
  totalGroupedCount
} from "./session-sidebar.logic";

const NOW_MS = Date.UTC(2026, 4, 9, 12, 0, 0);
const NOW_DATE = new Date(NOW_MS);

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

function makeSession(overrides: Partial<Session> & { sessionId: string }): Session {
  return {
    sessionName: overrides.sessionId,
    purpose: "general",
    isRunning: false,
    hasPendingApprovals: false,
    updatedAt: NOW_DATE.toISOString(),
    ...overrides
  } as Session;
}

describe("formatCompactTime", () => {
  test("returns 'now' for sub-minute diffs", () => {
    expect(formatCompactTime(isoMinutesAgo(0), NOW_MS)).toBe("now");
  });

  test("returns minutes for under an hour", () => {
    expect(formatCompactTime(isoMinutesAgo(35), NOW_MS)).toBe("35m");
  });

  test("returns hours for under a day", () => {
    expect(formatCompactTime(isoMinutesAgo(60 * 5), NOW_MS)).toBe("5h");
  });

  test("returns 'Yesterday' for exactly one day", () => {
    expect(formatCompactTime(isoMinutesAgo(60 * 24), NOW_MS)).toBe("Yesterday");
  });

  test("returns 'Nd' for multi-day diffs", () => {
    expect(formatCompactTime(isoMinutesAgo(60 * 24 * 4), NOW_MS)).toBe("4d");
  });
});

describe("isToday", () => {
  test("matches dates with the same year/month/day", () => {
    expect(isToday(NOW_DATE.toISOString(), NOW_DATE)).toBe(true);
  });

  test("rejects dates from a previous day", () => {
    const yesterday = new Date(NOW_MS - 24 * 60 * 60_000);
    expect(isToday(yesterday.toISOString(), NOW_DATE)).toBe(false);
  });
});

describe("initialsOf", () => {
  test("returns first letters of two name parts", () => {
    expect(initialsOf("Mathieu Dupuis", undefined)).toBe("MD");
  });

  test("falls back to email when name is missing", () => {
    expect(initialsOf(undefined, "alice@example.com")).toBe("AL");
  });

  test("returns '?' when neither name nor email is present", () => {
    expect(initialsOf(undefined, undefined)).toBe("?");
  });
});

describe("groupSessions", () => {
  test("attention takes priority over every group without duplicating or reordering sessions", () => {
    const sessions = [
      makeSession({ sessionId: "today" }),
      makeSession({ sessionId: "old", updatedAt: isoMinutesAgo(60 * 48) }),
      makeSession({ sessionId: "pinned" }),
      makeSession({ sessionId: "improvement", purpose: "skill_improvement" })
    ];
    const pins = new Set(["pinned"]);
    const groups = groupSessions(sessions, pins, "", NOW_DATE, new Set(sessions.map((s) => s.sessionId)));
    expect(groups.attention).toEqual(sessions);
    expect(totalGroupedCount(groups)).toBe(sessions.length);
    const resolved = groupSessions(sessions, pins, "", NOW_DATE, new Set());
    expect(resolved.attention).toEqual([]);
    expect(resolved.pinned).toEqual([sessions[2]]);
    expect(resolved.today).toEqual([sessions[0]]);
    expect(resolved.earlier).toEqual([sessions[1]]);
    expect(resolved.improvement).toEqual([sessions[3]]);
  });

  test("search filters attention sessions and ignores attention IDs outside the list", () => {
    const sessions = [makeSession({ sessionId: "a", sessionName: "Research" }), makeSession({ sessionId: "b" })];
    const groups = groupSessions(sessions, new Set(), "  RESEARCH  ", NOW_DATE, new Set(["a", "b", "missing"]));
    expect(groups.attention).toEqual([sessions[0]]);
    expect(totalGroupedCount(groups)).toBe(1);
    expect(totalGroupedCount(groupSessions(sessions, new Set(), "no match", NOW_DATE, new Set(["a"])))).toBe(0);
  });

  test("places skill_improvement sessions in their own bucket", () => {
    const sessions = [
      makeSession({ sessionId: "imp", purpose: "skill_improvement" }),
      makeSession({ sessionId: "regular" })
    ];
    const groups = groupSessions(sessions, new Set(), "", NOW_DATE);
    expect(groups.improvement.map((s) => s.sessionId)).toEqual(["imp"]);
    expect(groups.today.map((s) => s.sessionId)).toEqual(["regular"]);
  });

  test("pinned sessions outrank today/earlier classification", () => {
    const sessions = [makeSession({ sessionId: "a" })];
    const groups = groupSessions(sessions, new Set(["a"]), "", NOW_DATE);
    expect(groups.pinned.map((s) => s.sessionId)).toEqual(["a"]);
    expect(groups.today).toEqual([]);
  });

  test("non-today + non-pinned sessions land in earlier", () => {
    const old = makeSession({
      sessionId: "old",
      updatedAt: new Date(NOW_MS - 5 * 24 * 60 * 60_000).toISOString()
    });
    const groups = groupSessions([old], new Set(), "", NOW_DATE);
    expect(groups.earlier.map((s) => s.sessionId)).toEqual(["old"]);
  });

  test("filters by case-insensitive substring match on sessionName", () => {
    const sessions = [
      makeSession({ sessionId: "a", sessionName: "Hello World" }),
      makeSession({ sessionId: "b", sessionName: "Goodbye" })
    ];
    const groups = groupSessions(sessions, new Set(), "world", NOW_DATE);
    expect(groups.today.map((s) => s.sessionId)).toEqual(["a"]);
  });
});

describe("totalGroupedCount", () => {
  test("sums all five buckets", () => {
    const groups = {
      attention: [makeSession({ sessionId: "e" })],
      pinned: [makeSession({ sessionId: "a" })],
      today: [makeSession({ sessionId: "b" }), makeSession({ sessionId: "c" })],
      earlier: [],
      improvement: [makeSession({ sessionId: "d" })]
    };
    expect(totalGroupedCount(groups)).toBe(5);
  });
});
