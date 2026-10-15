import { describe, expect, it } from "vitest";

import { SHORTCUTS, ariaKeyShortcut, matchesShortcut, shortcutKeys } from "./keyboard-shortcuts";

const key = { key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false };

describe("matchesShortcut", () => {
  it("uses Cmd on Apple devices and leaves Ctrl+letter to text editing", () => {
    expect(matchesShortcut({ ...key, metaKey: true }, SHORTCUTS.quickJump, true)).toBe(true);
    expect(matchesShortcut({ ...key, ctrlKey: true }, SHORTCUTS.quickJump, true)).toBe(false);
  });
  it("uses Ctrl elsewhere and ignores other modifiers", () => {
    expect(matchesShortcut({ ...key, ctrlKey: true }, SHORTCUTS.quickJump, false)).toBe(true);
    expect(matchesShortcut({ ...key, key: "K", ctrlKey: true }, SHORTCUTS.quickJump, false)).toBe(true);
    expect(matchesShortcut({ ...key, ctrlKey: true, shiftKey: true }, SHORTCUTS.quickJump, false)).toBe(false);
    expect(matchesShortcut({ ...key, metaKey: true }, SHORTCUTS.quickJump, false)).toBe(false);
    expect(matchesShortcut({ ...key, ctrlKey: true, repeat: true }, SHORTCUTS.quickJump, false)).toBe(false);
  });
  it("needs Shift for Shift shortcuts", () => {
    expect(matchesShortcut({ ...key, key: "O", metaKey: true, shiftKey: true }, SHORTCUTS.newSession, true)).toBe(true);
    expect(matchesShortcut({ ...key, key: "o", metaKey: true }, SHORTCUTS.newSession, true)).toBe(false);
  });
  it("accepts symbols typed with Shift and rejects them with Cmd or Ctrl", () => {
    expect(matchesShortcut({ ...key, key: "?", shiftKey: true }, SHORTCUTS.help, true)).toBe(true);
    expect(matchesShortcut({ ...key, key: "/", shiftKey: true }, SHORTCUTS.focusComposer, false)).toBe(true);
    expect(matchesShortcut({ ...key, key: "/", ctrlKey: true }, SHORTCUTS.focusComposer, false)).toBe(false);
    expect(matchesShortcut({ ...key, key: "?", altKey: true }, SHORTCUTS.help, false)).toBe(false);
  });
});

it("labels keys for the platform", () => {
  expect(shortcutKeys(SHORTCUTS.newSession, true)).toEqual(["⌘", "⇧", "O"]);
  expect(shortcutKeys(SHORTCUTS.newSession, false)).toEqual(["Ctrl", "Shift", "O"]);
  expect(shortcutKeys(SHORTCUTS.stop, false)).toEqual(["Esc"]);
  expect(ariaKeyShortcut(SHORTCUTS.toggleArtifacts, true)).toBe("Meta+.");
  expect(ariaKeyShortcut(SHORTCUTS.newSession, false)).toBe("Control+Shift+O");
});
