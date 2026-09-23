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
    expect(deriveAttentionSessionIds(sessions, null, 0, false)).toEqual(new Set(["a"]));
  });

  test("a fresh approval count overrides the saved flag for the selected session", () => {
    const sessions = [makeSession({ sessionId: "a", hasPendingApprovals: true })];
    expect(deriveAttentionSessionIds(sessions, "a", 0, true)).toEqual(new Set());
  });

  test("a fresh count of the selected session does not clear other sessions", () => {
    const sessions = [
      makeSession({ sessionId: "a", hasPendingApprovals: true }),
      makeSession({ sessionId: "b", hasPendingApprovals: true })
    ];
    expect(deriveAttentionSessionIds(sessions, "a", 0, true)).toEqual(new Set(["b"]));
  });

  test("keeps the saved approval flag for the selected session without a fresh count", () => {
    const sessions = [makeSession({ sessionId: "a", hasPendingApprovals: true })];
    expect(deriveAttentionSessionIds(sessions, "a", 0, false)).toEqual(new Set(["a"]));
  });

  test("adds the selected session when live pending approvals exist even if server-side hasn't caught up", () => {
    const sessions = [makeSession({ sessionId: "a" })];
    expect(deriveAttentionSessionIds(sessions, "a", 1, true)).toEqual(new Set(["a"]));
    expect(deriveAttentionSessionIds(sessions, "a", 1, false)).toEqual(new Set(["a"]));
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
