import { describe, expect, test } from "vitest";

import type { RuntimeSessionSummary } from "@cogniplane/shared-types";

import {
  countActiveSessions,
  filterRuntimeSessions,
  formatRuntimeTimestamp
} from "./admin-runtime-card.logic";

function makeSession(
  partial: Partial<RuntimeSessionSummary> & { runtimeId: string; sessionId: string }
): RuntimeSessionSummary {
  return {
    runtimeId: partial.runtimeId,
    sessionId: partial.sessionId,
    status: partial.status ?? "running",
    healthStatus: partial.healthStatus ?? "healthy",
    runtimeProvider: partial.runtimeProvider ?? "codex",
    mode: partial.mode ?? null,
    startedAt: partial.startedAt ?? "2026-05-09T12:00:00Z",
    lastActiveAt: partial.lastActiveAt ?? "2026-05-09T12:00:00Z",
    updatedAt: partial.updatedAt ?? "2026-05-09T12:00:00Z",
    configSummary: partial.configSummary ?? {
      runtimePolicy: { id: "default", version: 1 },
      skillVersions: [],
      mcpServerVersions: []
    }
  } as RuntimeSessionSummary;
}

describe("filterRuntimeSessions", () => {
  const sessions = [
    makeSession({ runtimeId: "rt-aaa", sessionId: "sess-1", status: "running" }),
    makeSession({ runtimeId: "rt-bbb", sessionId: "sess-2", status: "stopped" }),
    makeSession({ runtimeId: "rt-ccc", sessionId: "sess-3", status: "starting" })
  ];

  test("empty search returns all when status is 'all'", () => {
    expect(filterRuntimeSessions(sessions, "", "all")).toHaveLength(3);
  });

  test("search matches sessionId or runtimeId case-insensitively", () => {
    expect(filterRuntimeSessions(sessions, "AAA", "all")).toHaveLength(1);
    expect(filterRuntimeSessions(sessions, "sess-2", "all")).toHaveLength(1);
  });

  test("'active' bucket excludes stopped sessions", () => {
    const result = filterRuntimeSessions(sessions, "", "active");
    expect(result.map((s) => s.sessionId)).toEqual(["sess-1", "sess-3"]);
  });

  test("'stopped' bucket only includes stopped sessions", () => {
    const result = filterRuntimeSessions(sessions, "", "stopped");
    expect(result.map((s) => s.sessionId)).toEqual(["sess-2"]);
  });

  test("search and status combine (AND)", () => {
    const result = filterRuntimeSessions(sessions, "rt-", "stopped");
    expect(result).toHaveLength(1);
  });
});

describe("countActiveSessions", () => {
  test("counts non-stopped sessions", () => {
    const sessions = [
      makeSession({ runtimeId: "a", sessionId: "1", status: "running" }),
      makeSession({ runtimeId: "b", sessionId: "2", status: "stopped" }),
      makeSession({ runtimeId: "c", sessionId: "3", status: "starting" })
    ];
    expect(countActiveSessions(sessions)).toBe(2);
  });
});

describe("formatRuntimeTimestamp", () => {
  test("nullish renders as 'n/a'", () => {
    expect(formatRuntimeTimestamp(null)).toBe("n/a");
  });

  test("renders something for a valid ISO", () => {
    expect(formatRuntimeTimestamp("2026-05-09T12:00:00Z")).toMatch(/\d/);
  });
});
