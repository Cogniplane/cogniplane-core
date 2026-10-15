// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MouseEvent } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CONFIRM_LEAVE_MESSAGE, useConfirmLeave } from "./use-confirm-leave";

function Page(props: { dirty: boolean; onNavigate: () => void }) {
  useConfirmLeave(props.dirty);
  // A Next.js Link calls preventDefault and routes in its React click handler.
  const route = (event: MouseEvent) => { event.preventDefault(); props.onNavigate(); };
  return <>
    <a href="/admin/history" onClick={route}>History</a>
    <a href="/admin/models?provider=openai" onClick={route}>OpenAI key</a>
  </>;
}

beforeEach(() => window.history.replaceState(null, "", "/admin/models"));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("asks before a link leaves a page with unsaved changes and stays when refused", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const onNavigate = vi.fn();
  render(<Page dirty onNavigate={onNavigate} />);
  fireEvent.click(screen.getByRole("link", { name: "History" }));
  expect(confirm).toHaveBeenCalledWith(CONFIRM_LEAVE_MESSAGE);
  expect(onNavigate).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("link", { name: "History" }));
  expect(onNavigate).toHaveBeenCalledOnce();
});

it("does not ask for a link on the same page or when nothing changed", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const onNavigate = vi.fn();
  const view = render(<Page dirty onNavigate={onNavigate} />);
  fireEvent.click(screen.getByRole("link", { name: "OpenAI key" }));
  view.rerender(<Page dirty={false} onNavigate={onNavigate} />);
  fireEvent.click(screen.getByRole("link", { name: "History" }));
  expect(confirm).not.toHaveBeenCalled();
  expect(onNavigate).toHaveBeenCalledTimes(2);
});

it("asks the browser before reload or close only while dirty", () => {
  const view = render(<Page dirty onNavigate={() => {}} />);
  const dirtyUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirtyUnload);
  expect(dirtyUnload.defaultPrevented).toBe(true);

  view.rerender(<Page dirty={false} onNavigate={() => {}} />);
  const cleanUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(cleanUnload);
  expect(cleanUnload.defaultPrevented).toBe(false);
});
