// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AdminSessionsFilters, EMPTY_FILTER_STATE, type SessionsFilterState } from "./admin-sessions-filters";

// Radix Select scrolls the chosen option into view; jsdom has no scrollIntoView.
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.useRealTimers();
});

const filtered: SessionsFilterState = {
  userId: "u1", from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z", status: "errored", alert: ["pii-blocked"]
};

function renderFilters(state: SessionsFilterState = EMPTY_FILTER_STATE) {
  const onChange = vi.fn<(next: SessionsFilterState) => void>();
  const onClear = vi.fn();
  render(<AdminSessionsFilters state={state} onChange={onChange} onClear={onClear} />);
  return { onChange, onClear };
}

async function choose(combobox: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: combobox }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

it("says when no filter is applied", () => {
  renderFilters();

  expect(screen.getByText("No filters applied")).toBeTruthy();
});

it("shows a chip for each active filter and fills the inputs", () => {
  renderFilters(filtered);

  expect(screen.queryByText("No filters applied")).toBeNull();
  expect(screen.getByText("User: u1")).toBeTruthy();
  expect(screen.getByText("Status: errored")).toBeTruthy();
  expect(screen.getByText("Alert: PII blocked")).toBeTruthy();
  expect((screen.getByLabelText("User") as HTMLInputElement).value).toBe("u1");
  expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-01");
  expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("2026-09-30");
  expect(screen.getByRole("combobox", { name: "Status" }).textContent).toBe("Errored");
  expect(screen.getByRole("combobox", { name: "Alert" }).textContent).toBe("PII blocked");
});

it("clears all filters", () => {
  const { onClear, onChange } = renderFilters(filtered);

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

  expect(onClear).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
});

it("changes one field and keeps the others", () => {
  const { onChange } = renderFilters(filtered);

  fireEvent.change(screen.getByLabelText("User"), { target: { value: "u2" } });
  // The day starts the "from" range and ends the "to" range.
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-15" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-20" } });
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });

  expect(onChange.mock.calls.map(([next]) => next)).toEqual([
    { ...filtered, userId: "u2" },
    { ...filtered, from: "2026-08-15T00:00:00Z" },
    { ...filtered, to: "2026-08-20T23:59:59Z" },
    { ...filtered, from: "" }
  ]);
});

it.each([
  ["Last 24h", 1],
  ["Last 7d", 7],
  ["Last 30d", 30]
])("applies the %s preset ending now", (label, days) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
  const { onChange } = renderFilters(filtered);

  fireEvent.click(screen.getByRole("button", { name: label }));

  const from = new Date(Date.parse("2026-10-03T12:00:00.000Z") - days * 86_400_000).toISOString();
  expect(onChange).toHaveBeenCalledWith({ ...filtered, from, to: "2026-10-03T12:00:00.000Z" });
});

it("picks a status, and All statuses clears it", async () => {
  const { onChange } = renderFilters({ ...EMPTY_FILTER_STATE, status: "active" });

  await choose("Status", "Errored");
  await choose("Status", "All statuses");

  expect(onChange.mock.calls.map(([next]) => next.status)).toEqual(["errored", ""]);
});

it("picks one alert, and All alerts clears it", async () => {
  const { onChange } = renderFilters({ ...EMPTY_FILTER_STATE, alert: ["errored"] });

  await choose("Alert", "Approval pending");
  await choose("Alert", "All alerts");

  expect(onChange.mock.calls.map(([next]) => next.alert)).toEqual([["approval-pending"], []]);
});

it("locks the alert picker when the URL selected several alerts", () => {
  renderFilters({ ...EMPTY_FILTER_STATE, alert: ["pii-blocked", "errored"] });

  const alert = screen.getByRole("combobox", { name: "Alert" }) as HTMLButtonElement;
  expect(alert.disabled).toBe(true);
  expect(alert.textContent).toBe("Multiple (2)");
  expect(screen.getByText("Alerts: 2")).toBeTruthy();
});
