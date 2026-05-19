import { describe, expect, test } from "vitest";

import {
  canSubmitDraft,
  canSubmitDraftViaKeyboard,
  providerLabel,
  shouldConfirmProviderChange
} from "./composer.logic";

describe("providerLabel", () => {
  test("renders human-readable names for known providers", () => {
    expect(providerLabel("claude-code")).toBe("Claude");
    expect(providerLabel("codex")).toBe("Codex");
  });
});

describe("canSubmitDraft", () => {
  test("requires both a selected session and non-empty trimmed draft", () => {
    expect(canSubmitDraft("s1", "hello")).toBe(true);
    expect(canSubmitDraft(null, "hello")).toBe(false);
    expect(canSubmitDraft("s1", "")).toBe(false);
    expect(canSubmitDraft("s1", "   ")).toBe(false);
  });
});

describe("canSubmitDraftViaKeyboard", () => {
  test("blocks while a turn is in flight even when draft + session are present", () => {
    expect(canSubmitDraftViaKeyboard("s1", false, "hello")).toBe(true);
    expect(canSubmitDraftViaKeyboard("s1", true, "hello")).toBe(false);
  });

  test("inherits the no-session and empty-draft guards from canSubmitDraft", () => {
    expect(canSubmitDraftViaKeyboard(null, false, "hello")).toBe(false);
    expect(canSubmitDraftViaKeyboard("s1", false, "   ")).toBe(false);
  });
});

describe("shouldConfirmProviderChange", () => {
  test("never confirms when the requested provider matches the current one", () => {
    expect(shouldConfirmProviderChange("codex", "codex", "s1", true)).toBe(false);
  });

  test("confirms only when there is a session AND it has conversation history", () => {
    expect(shouldConfirmProviderChange("codex", "claude-code", "s1", true)).toBe(true);
    expect(shouldConfirmProviderChange("codex", "claude-code", "s1", false)).toBe(false);
    expect(shouldConfirmProviderChange("codex", "claude-code", null, true)).toBe(false);
    expect(shouldConfirmProviderChange("codex", "claude-code", null, false)).toBe(false);
  });
});
