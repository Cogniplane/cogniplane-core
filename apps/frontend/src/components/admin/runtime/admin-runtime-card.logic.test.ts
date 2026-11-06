import { describe, expect, test } from "vitest";
import { withUtcDateLocale } from "../../../test-helpers/date-locale";
import { RuntimeSessionSummarySchema, type RuntimeSessionSummary } from "@cogniplane/shared-types";
import { countActiveSessions, filterRuntimeSessions, formatRuntimeTimestamp, runtimeStatusBucket } from "./admin-runtime-card.logic";

withUtcDateLocale();
function session(status: string, i: number): RuntimeSessionSummary {
  return RuntimeSessionSummarySchema.parse({
    sessionId: `session-${i}`, runtimeId: `runtime-${i}`, status, healthStatus: "healthy", runtimeProvider: "deep-agents",
    startedAt: null, lastActiveAt: null, updatedAt: "2026-05-09T12:00:00Z",
    configSummary: { manifestHash: "m", configBundleHash: "c", runtimePolicy: { id: "default", version: 1, hash: "p" }, skillVersions: [], mcpServerVersions: [] }
  });
}
const sessions = ["active", "terminated", "error", "starting", "stopped", "future-state"].map(session);
describe("recorded lifecycle", () => {
  test("only counts current active records, including when a terminated record still reports healthy", () => {
    expect(countActiveSessions(sessions)).toBe(1);
    expect(filterRuntimeSessions(sessions, "", "active").map(s => s.status)).toEqual(["active"]);
    expect(filterRuntimeSessions(sessions, "", "terminated").map(s => s.status)).toEqual(["terminated"]);
  });
  test("keeps legacy and unknown lifecycle values under Other states", () => {
    expect(filterRuntimeSessions(sessions, "", "other").map(s => s.status)).toEqual(["starting", "stopped", "future-state"]);
    expect(runtimeStatusBucket("")).toBe("other");
    expect(countActiveSessions([session("future-state", 9)])).toBe(0);
  });
  test("combines a trimmed case-insensitive ID search with lifecycle", () => {
    expect(filterRuntimeSessions(sessions, " RUNTIME-1 ", "all")).toEqual([sessions[1]]);
    expect(filterRuntimeSessions(sessions, "session-1", "active")).toEqual([]);
    expect(filterRuntimeSessions(sessions, "", "error")).toEqual([sessions[2]]);
  });
});
describe("timestamps", () => {
  test("makes missing timestamps explicit", () => expect(formatRuntimeTimestamp(null)).toBe("Unavailable"));
  test("uses the local en-CA calendar format", () => expect(formatRuntimeTimestamp("2026-05-09T12:00:00Z")).toBe("May 9, 2026, 12:00 p.m."));
});
