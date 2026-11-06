import { describe, expect, it } from "vitest";

import { inspectDraft } from "./widget-draft.logic";
import { CHAT_STARTERS, STARTER_LIMITS } from "./chat-starters.logic";

describe("the starters of an empty chat", () => {
  it("are few, with unique ids and labels, and fit a phone", () => {
    expect(CHAT_STARTERS).toHaveLength(STARTER_LIMITS.count);
    expect(new Set(CHAT_STARTERS.map((starter) => starter.id)).size).toBe(CHAT_STARTERS.length);
    expect(new Set(CHAT_STARTERS.map((starter) => starter.label)).size).toBe(CHAT_STARTERS.length);
    for (const starter of CHAT_STARTERS) {
      expect(starter.label.length, starter.id).toBeGreaterThan(0);
      expect(starter.label.length, starter.id).toBeLessThanOrEqual(STARTER_LIMITS.label);
      expect(starter.hint.length, starter.id).toBeGreaterThan(0);
      expect(starter.hint.length, starter.id).toBeLessThanOrEqual(STARTER_LIMITS.hint);
      expect(starter.draft.length, starter.id).toBeLessThanOrEqual(STARTER_LIMITS.draft);
    }
  });

  it("hold drafts of plain text that the draft notice has nothing to warn about", () => {
    for (const starter of CHAT_STARTERS) {
      expect(inspectDraft(starter.draft).warnings, starter.id).toEqual([]);
      expect(starter.draft, starter.id).toBe(starter.draft.trim());
      expect(starter.draft, starter.id).not.toContain("\n");
    }
  });
});
