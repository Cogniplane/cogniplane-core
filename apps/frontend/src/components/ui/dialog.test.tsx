// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

function PendingForm({ pending, scrollBody }: { pending: boolean; scrollBody: boolean }) {
  return <Dialog open>
    <DialogContent showCloseButton={!pending} scrollBody={scrollBody}>
      <DialogTitle>Change the budget</DialogTitle>
      <DialogDescription>Review the amount before saving.</DialogDescription>
      <input aria-label="Monthly limit" defaultValue="100" />
    </DialogContent>
  </Dialog>;
}

it.each([true, false])("keeps form identity, value, and focus while Close hides, scrollBody=%s", async (scrollBody) => {
  const view = render(<PendingForm pending={false} scrollBody={scrollBody} />);
  const input = screen.getByRole("textbox", { name: "Monthly limit" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "250" } });

  view.rerender(<PendingForm pending scrollBody={scrollBody} />);
  expect(screen.getByRole("textbox", { name: "Monthly limit" })).toBe(input);
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("250");
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

  view.rerender(<PendingForm pending={false} scrollBody={scrollBody} />);
  expect(screen.getByRole("textbox", { name: "Monthly limit" })).toBe(input);
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("250");
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
});

it("reveals an owned focused field after body resize without scrolling for footer focus", async () => {
  let resized!: () => void;
  let body!: Element;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe(element: Element) { body = element; }
    disconnect() {}
  });
  render(<Dialog open>
    <DialogContent footer={<button>Continue</button>}>
      <DialogTitle>Confirm the change</DialogTitle>
      <DialogDescription>Enter the confirmation code.</DialogDescription>
      <input aria-label="Code" />
    </DialogContent>
  </Dialog>);
  const input = screen.getByRole("textbox", { name: "Code" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100 } as DOMRect);
  const inputRect = vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ top: 70, bottom: 106 } as DOMRect);
  const scroll = vi.fn();
  Object.defineProperty(input, "scrollIntoView", { configurable: true, value: scroll });
  resized();
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(document.activeElement).toBe(input);
  inputRect.mockReturnValue({ top: 60, bottom: 96 } as DOMRect);
  resized();
  expect(scroll).toHaveBeenCalledTimes(1);
  const footerAction = screen.getByRole("button", { name: "Continue" });
  footerAction.focus();
  resized();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(footerAction);
});
