// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminSessionsPresets } from "./admin-sessions-presets";
import { EMPTY_FILTER_STATE, presetRange, type SessionsFilterState } from "./admin-sessions-filters.logic";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("matches the complete preset including user and current creation range", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  const state: SessionsFilterState = { ...EMPTY_FILTER_STATE, ...presetRange(7), alert: ["approval-pending"], status: "active" };
  const onApply = vi.fn();
  const view = render(<AdminSessionsPresets state={state} onApply={onApply} />);
  const button = screen.getByRole("button", { name: "Approvals pending" });
  expect(button.getAttribute("aria-pressed")).toBe("true");
  view.rerender(<AdminSessionsPresets state={{ ...state, userId: "another-user" }} onApply={onApply} />);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  view.rerender(<AdminSessionsPresets state={{ ...state, ...presetRange(30) }} onApply={onApply} />);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  expect(onApply).toHaveBeenCalledWith(state);
});
