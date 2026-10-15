"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/** A key and its modifiers. `mod` is Cmd on Apple devices and Ctrl elsewhere. */
export type Shortcut = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  /** Where the shortcut works. The shortcuts dialog groups by this value. */
  scope: "Everywhere" | "Chat";
  label: string;
};

// Browsers reserve new window, new tab, close tab, and quit. Pages cannot take them.
// Cmd/Ctrl+Shift+O and Cmd/Ctrl+Shift+S replace bookmark and screenshot shortcuts
// in Chrome and Firefox, as in ChatGPT. Shift+Esc is not used: Chrome opens its
// task manager with it on Windows and Linux.
export const SHORTCUTS = {
  quickJump: { key: "k", mod: true, scope: "Everywhere", label: "Jump to a page, session, or project" },
  help: { key: "?", scope: "Everywhere", label: "Show keyboard shortcuts" },
  newSession: { key: "o", mod: true, shift: true, scope: "Chat", label: "New session" },
  toggleSidebar: { key: "s", mod: true, shift: true, scope: "Chat", label: "Show or hide the sidebar" },
  toggleArtifacts: { key: ".", mod: true, scope: "Chat", label: "Show or hide the artifacts panel" },
  focusComposer: { key: "/", scope: "Chat", label: "Write a message" },
  stop: { key: "Escape", scope: "Chat", label: "Stop the agent while it works" }
} as const satisfies Record<string, Shortcut>;

export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(`${navigator.platform} ${navigator.userAgent}`);
}

const noSubscribe = () => () => {};
/** `isApplePlatform()` for rendering. The server render assumes a non-Apple device. */
export function useApplePlatform(): boolean {
  return useSyncExternalStore(noSubscribe, isApplePlatform, () => false);
}

// Shortcuts never act on top of another dialog, alert dialog, or menu.
export function otherOverlayOpen(): boolean {
  return document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], dialog[open]'
  ) !== null;
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.matches("input, textarea, select");
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">,
  shortcut: Pick<Shortcut, "key" | "mod" | "shift">,
  apple: boolean
): boolean {
  if (event.repeat || event.altKey || event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  // Some layouts need Shift to type "?", "/", or ".". Shift counts only for letters.
  if (/^[a-z]$/i.test(shortcut.key) && event.shiftKey !== Boolean(shortcut.shift)) return false;
  // On Apple devices Ctrl+letter edits text fields (Ctrl+K deletes to the end of the line). Leave it alone.
  if (!shortcut.mod) return !event.metaKey && !event.ctrlKey;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The keys to show for a shortcut, one entry per key cap. */
export function shortcutKeys(shortcut: Pick<Shortcut, "key" | "mod" | "shift">, apple: boolean): string[] {
  const key = shortcut.key === "Escape" ? "Esc" : shortcut.key.toUpperCase();
  return [...(shortcut.mod ? [apple ? "⌘" : "Ctrl"] : []), ...(shortcut.shift ? [apple ? "⇧" : "Shift"] : []), key];
}

/** The value for `aria-keyshortcuts`. */
export function ariaKeyShortcut(shortcut: Pick<Shortcut, "key" | "mod" | "shift">, apple: boolean): string {
  return [...(shortcut.mod ? [apple ? "Meta" : "Control"] : []), ...(shortcut.shift ? ["Shift"] : []),
    /^[a-z]$/i.test(shortcut.key) ? shortcut.key.toUpperCase() : shortcut.key].join("+");
}

/**
 * Calls `handler` when the shortcut is pressed anywhere on the page.
 * Shortcuts with a modifier also work in text fields. Shortcuts without one do not,
 * so typing "/" or "?" stays text. No shortcut acts in a rich text editor or over
 * an open dialog or menu.
 */
export function useShortcut(shortcut: Shortcut, handler: (event: KeyboardEvent) => void, enabled = true): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShortcut(event, shortcut, isApplePlatform())) return;
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      if (!shortcut.mod && shortcut.key !== "Escape" && isTextField(event.target)) return;
      if (otherOverlayOpen()) return;
      event.preventDefault();
      handlerRef.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, shortcut]);
}
