// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionCopyButton } from "./session-copy-button";
const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => { cleanup(); if (original) Object.defineProperty(navigator, "clipboard", original); else delete (navigator as { clipboard?: unknown }).clipboard; });
it("shows local failure when clipboard is unavailable or denied", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  render(<SessionCopyButton value="sample" label="Copy session ID" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Could not copy");
  expect(screen.getByRole("button").getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
});
it("guards duplicate copies, keeps focus and reports the actual result", async () => {
  let finish!: () => void;
  const writeText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<SessionCopyButton value="sample" label="Copy session ID" />);
  const button = screen.getByRole("button"); button.focus();
  fireEvent.click(button); fireEvent.click(button);
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(button.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied to clipboard."));
  expect(document.activeElement).toBe(button);
});
