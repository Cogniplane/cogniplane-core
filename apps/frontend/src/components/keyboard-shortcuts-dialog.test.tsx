// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

// A focusable stand-in: the real Build details disclosure is the first tabbable element.
vi.mock("./build-details", () => ({ BuildDetails: () => <button type="button">Build details</button> }));

import { KeyboardShortcutsDialog, openKeyboardShortcuts } from "./keyboard-shortcuts-dialog";

afterEach(() => { cleanup(); document.body.innerHTML = ""; });

it("opens with ? and lists the shortcuts by scope", async () => {
  render(<KeyboardShortcutsDialog />);
  fireEvent.keyDown(window, { key: "?", shiftKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  const chat = within(dialog).getByRole("region", { name: "Chat" });
  expect(within(chat).getByText("New session")).toBeTruthy();
  expect(within(within(dialog).getByRole("region", { name: "Everywhere" })).getByText("Jump to a page, session, or project")).toBeTruthy();
});

it("returns focus to the opener after the shortcuts dialog closes", async () => {
  render(<><button onClick={openKeyboardShortcuts}>Show shortcuts</button><KeyboardShortcutsDialog /></>);
  const trigger = screen.getByRole("button", { name: "Show shortcuts" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("leaves ? to text fields, and opens from the menu", async () => {
  render(<><input aria-label="Search" /><KeyboardShortcutsDialog /></>);
  fireEvent.keyDown(screen.getByLabelText("Search"), { key: "?", shiftKey: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => openKeyboardShortcuts());
  expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
});
