// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberLinkResponse } from "@cogniplane/shared-types";
import { IssuedLinkDialog } from "./issued-link-dialog";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const manual = (id: string): MemberLinkResponse => ({ email: null, link: { url: `https://specimen.invalid/FICTIONAL-${id}`, purpose: "password_reset", expiresAt: "2026-11-08T12:00:00Z" } });
function clipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}
afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("IssuedLinkDialog", () => {
  it("explains denied copying next to the selectable one-time link and keeps focus", async () => {
    clipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<IssuedLinkDialog delivery={manual("A")} name="Fictional person" onClose={() => {}} />);
    const button = screen.getByRole("button", { name: "Copy link" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/could not copy.*select the link above/i));
    expect(document.activeElement).toBe(button);
    const field = screen.getByRole("textbox", { name: "One-time link" }) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    fireEvent.focus(field);
    expect(field.selectionEnd).toBe(field.value.length);
    expect(screen.getByText(/cannot see it again/i)).toBeTruthy();
    expect(screen.getByText(/do not post it in a shared channel/i)).toBeTruthy();
  });

  it("guards held copying, keeps the pending owner focusable and ignores completion after close", async () => {
    let resolve!: () => void;
    const writeText = vi.fn(() => new Promise<void>(yes => { resolve = yes; }));
    clipboard(writeText);
    const delivery = manual("A");
    const onClose = vi.fn();
    const { rerender } = render(<IssuedLinkDialog delivery={delivery} name="Fictional person" onClose={onClose} />);
    const button = screen.getByRole("button", { name: "Copy link" });
    button.focus();
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<IssuedLinkDialog delivery={null} name="Fictional person" onClose={onClose} />);
    await act(async () => resolve());
    rerender(<IssuedLinkDialog delivery={delivery} name="Fictional person" onClose={onClose} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("resets feedback when delivery changes and ignores the older pending copy", async () => {
    let resolve!: () => void;
    clipboard(vi.fn().mockImplementationOnce(() => new Promise<void>(yes => { resolve = yes; })).mockResolvedValue(undefined));
    const { rerender } = render(<IssuedLinkDialog delivery={manual("A")} name="Fictional person" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    rerender(<IssuedLinkDialog delivery={manual("B")} name="Fictional person" onClose={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe("");
    await act(async () => resolve());
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied."));
    rerender(<IssuedLinkDialog delivery={manual("C")} name="Fictional person" onClose={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("keeps email delivery distinct from manual delivery and clears failed feedback", async () => {
    clipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const { rerender } = render(<IssuedLinkDialog delivery={manual("A")} name="Fictional person" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/could not copy/i));
    rerender(<IssuedLinkDialog delivery={{ link: null, email: { to: "fictional@specimen.invalid", purpose: "account_setup", expiresAt: "2026-11-08T12:00:00Z" } }} name="Fictional person" onClose={() => {}} />);
    expect(screen.getByRole("heading").textContent).toMatch(/setup link sent/i);
    expect(screen.getByText(/we emailed a one-time link.*works once and ends/i)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(screen.queryByText(/could not copy/i)).toBeNull();
  });
});
