import { describe, expect, test } from "vitest";
import type { Message, Model, RuntimeProvider, Session } from "@cogniplane/shared-types";

import {
  ARTIFACT_PANE_WIDTH,
  clampArtifactPaneWidth,
  deriveAttentionSessionIds,
  deriveStreamingSessionIds,
  formatSessionForClipboard,
  messagesContainHistory,
  modelFallbackForProvider,
  readStoredArtifactPaneWidth,
  sortDisplayModels
} from "./chat-shell.logic";

function makeModel(id: string, provider: RuntimeProvider, isDefault = false): Model {
  return {
    id,
    provider,
    displayName: id,
    description: "",
    isDefault,
    supportedEfforts: [],
    defaultEffort: null
  } as unknown as Model;
}

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

function makeMessage(overrides: Partial<Message>): Message {
  return {
    role: "user",
    content: "",
    status: "completed",
    ...overrides
  } as Message;
}

describe("modelFallbackForProvider", () => {
  const models = [
    makeModel("c-default", "codex", true),
    makeModel("c-other", "codex"),
    makeModel("k-default", "claude-code", true),
    makeModel("k-other", "claude-code")
  ];

  test("returns currentModel when it belongs to the target provider", () => {
    expect(modelFallbackForProvider("codex", models, "c-other")).toBe("c-other");
  });

  test("returns the provider's default when currentModel is from a different provider", () => {
    expect(modelFallbackForProvider("claude-code", models, "c-default")).toBe("k-default");
  });

  test("falls back to the first available model when no default is marked", () => {
    const noDefault = [makeModel("only", "codex")];
    expect(modelFallbackForProvider("codex", noDefault, "missing")).toBe("only");
  });

  test("returns null when the provider has no models", () => {
    expect(modelFallbackForProvider("claude-code", [makeModel("c", "codex")], "x")).toBeNull();
  });
});

describe("sortDisplayModels", () => {
  test("filters by enabled providers and floats the default-provider models to the top", () => {
    const all = [
      makeModel("c1", "codex"),
      makeModel("k1", "claude-code"),
      makeModel("c2", "codex"),
      makeModel("k2", "claude-code")
    ];
    const sorted = sortDisplayModels(all, ["codex", "claude-code"], "claude-code");
    expect(sorted.map((m) => m.id)).toEqual(["k1", "k2", "c1", "c2"]);
  });

  test("excludes models from disabled providers", () => {
    const all = [makeModel("c", "codex"), makeModel("k", "claude-code")];
    expect(sortDisplayModels(all, ["codex"], "codex").map((m) => m.id)).toEqual(["c"]);
  });
});

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

describe("messagesContainHistory", () => {
  test("ignores system messages and empty content", () => {
    const messages = [
      makeMessage({ role: "system", content: "x" }),
      makeMessage({ role: "user", content: "   " })
    ];
    expect(messagesContainHistory(messages)).toBe(false);
  });

  test("returns true for any non-system message with non-empty content", () => {
    expect(messagesContainHistory([makeMessage({ role: "user", content: "hi" })])).toBe(true);
  });
});

describe("clampArtifactPaneWidth", () => {
  test("clamps to the configured min/max", () => {
    expect(clampArtifactPaneWidth(1000, 50)).toBe(ARTIFACT_PANE_WIDTH.max);
    expect(clampArtifactPaneWidth(500, 490)).toBe(ARTIFACT_PANE_WIDTH.min);
  });

  test("returns the literal width when within bounds", () => {
    expect(clampArtifactPaneWidth(900, 500)).toBe(400);
  });
});

describe("readStoredArtifactPaneWidth", () => {
  test("rejects out-of-range and non-numeric values", () => {
    expect(readStoredArtifactPaneWidth("abc")).toBeNull();
    expect(readStoredArtifactPaneWidth("100")).toBeNull();
    expect(readStoredArtifactPaneWidth("9999")).toBeNull();
    expect(readStoredArtifactPaneWidth(null)).toBeNull();
  });

  test("accepts in-range values", () => {
    expect(readStoredArtifactPaneWidth("400")).toBe(400);
  });
});

describe("formatSessionForClipboard", () => {
  test("returns undefined for an empty session", () => {
    expect(formatSessionForClipboard([])).toBeUndefined();
  });

  test("formats only completed/streaming messages with role labels", () => {
    const messages = [
      makeMessage({ role: "user", content: "hi", status: "completed" }),
      makeMessage({ role: "assistant", content: "hello", status: "streaming" }),
      makeMessage({ role: "user", content: "draft", status: "pending" })
    ];
    expect(formatSessionForClipboard(messages)).toBe("You:\nhi\n\n---\n\nAgent:\nhello");
  });
});
