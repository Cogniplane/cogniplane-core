// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { KeyboardShortcutsDialog, openKeyboardShortcuts } from "./keyboard-shortcuts-dialog";

afterEach(() => { cleanup(); document.body.innerHTML = ""; });

it("opens with ? and lists the shortcuts by scope", async () => {
  render(<KeyboardShortcutsDialog />);
  fireEvent.keyDown(window, { key: "?", shiftKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  const chat = within(dialog).getByRole("region", { name: "Chat" });
  expect(within(chat).getByText("New session")).toBeTruthy();
  expect(within(within(dialog).getByRole("region", { name: "Everywhere" })).getByText("Jump to a page, session, or project")).toBeTruthy();
});

it("leaves ? to text fields, and opens from the menu", async () => {
  render(<><input aria-label="Search" /><KeyboardShortcutsDialog /></>);
  fireEvent.keyDown(screen.getByLabelText("Search"), { key: "?", shiftKey: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => openKeyboardShortcuts());
  expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
});
