import { describe, expect, test } from "vitest";
import type { Session } from "@cogniplane/shared-types";

import {
  deriveAttentionSessionIds,
  deriveStreamingSessionIds
} from "./session-list-derivations";

function makeSession(overrides: Partial<Session> & { sessionId: string }): Session {
  return {
    sessionName: overrides.sessionId,
    purpose: "general",
    isRunning: false,
    hasPendingApprovals: false,
    updatedAt: new Date().toISOString(),
    ...overrides
  } as Session;
}

describe("deriveAttentionSessionIds", () => {
  test("includes sessions that the server marks as having pending approvals", () => {
    const sessions = [
      makeSession({ sessionId: "a", hasPendingApprovals: true }),
      makeSession({ sessionId: "b" })
    ];
    expect(deriveAttentionSessionIds(sessions, null, 0)).toEqual(new Set(["a"]));
  });

  test("authoritative live state overrides server state for the selected session", () => {
    const sessions = [makeSession({ sessionId: "a", hasPendingApprovals: true })];
    expect(deriveAttentionSessionIds(sessions, "a", 0)).toEqual(new Set());
  });

  test("adds the selected session when live pending approvals exist even if server-side hasn't caught up", () => {
    const sessions = [makeSession({ sessionId: "a" })];
    expect(deriveAttentionSessionIds(sessions, "a", 1)).toEqual(new Set(["a"]));
  });
});

describe("deriveStreamingSessionIds", () => {
  test("merges server-side isRunning with the in-flight local stream id", () => {
    const sessions = [
      makeSession({ sessionId: "a", isRunning: true }),
      makeSession({ sessionId: "b" })
    ];
    expect(deriveStreamingSessionIds(sessions, "b")).toEqual(new Set(["a", "b"]));
  });

  test("returns an empty set when nothing is streaming", () => {
    expect(deriveStreamingSessionIds([], null)).toEqual(new Set());
  });
});
