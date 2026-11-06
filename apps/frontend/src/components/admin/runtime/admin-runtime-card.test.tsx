// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeSessionSummary } from "@cogniplane/shared-types";
import { AdminRuntimeCard } from "./admin-runtime-card";

const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
beforeEach(() => { Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }); });
afterEach(() => {
  cleanup();
  if (scrollDescriptor) Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});
function session(i: number, status = "active"): RuntimeSessionSummary {
  return { sessionId: `session-${i}`, runtimeId: `runtime-${i}`, status, healthStatus: "healthy", startedAt: null,
    lastActiveAt: null, updatedAt: "2026-10-01T10:00:00.000Z", runtimeProvider: "deep-agents",
    configSummary: { manifestHash: "m", configBundleHash: "c", runtimePolicy: { id: "default", version: 3, hash: "p" }, skillVersions: [{ id: "pdf", version: 1, hash: "s" }], mcpServerVersions: [] } };
}
function renderCard(overrides: Partial<Parameters<typeof AdminRuntimeCard>[0]> = {}) {
  const props: Parameters<typeof AdminRuntimeCard>[0] = {
    runtimeSessions: [], sessionsLoaded: true, sessionsLoading: false, sessionsRefreshing: false, sessionsError: null,
    runtimeConfig: null, configLoading: false, configRefreshing: false, configError: null,
    busyKey: null, rolloutResult: null, rolloutError: null,
    onRetrySessions: vi.fn(), onRetryConfig: vi.fn(), onPrepareRollout: vi.fn(), onDrainIdle: vi.fn(), onRefreshIdle: vi.fn(), ...overrides
  };
  return { props, ...render(<AdminRuntimeCard {...props} />) };
}
const rows = () => screen.queryAllByText(/^session-\d+$/).map(element => element.textContent);
it("states the recent-list limit and separates lifecycle from historical health", () => {
  renderCard({ runtimeSessions: [session(1), session(2, "terminated"), session(3, "unexpected")] });
  expect(screen.getByText("1 recorded active")).toBeTruthy();
  expect(screen.getByText("3 recent records")).toBeTruthy();
  expect(screen.getByText(/Up to 100 most recently updated records/)).toBeTruthy();
  expect(screen.getByText("Other state: unexpected")).toBeTruthy();
  expect(screen.getAllByText("Last health: healthy")).toHaveLength(3);
  expect(screen.getAllByText("1 skill pinned")).toHaveLength(3);
});
it.each(["loading", "error"])("does not turn an initial %s into zero records or filtered-empty copy", state => {
  renderCard({ sessionsLoaded: false, sessionsLoading: state === "loading", sessionsRefreshing: state === "loading", sessionsError: state === "error" ? "Offline" : null });
  expect(screen.queryByText("0 recent records")).toBeNull();
  expect(screen.queryByText(/No recent runtime records/)).toBeNull();
  expect(screen.queryByText(/No records match/)).toBeNull();
  expect(state === "loading" ? screen.getByRole("status") : screen.getByRole("alert")).toBeTruthy();
});
it("keeps loaded records and identifies a failed refresh", () => {
  renderCard({ runtimeSessions: [session(1)], sessionsError: "Offline" });
  expect(rows()).toEqual(["session-1"]);
  expect(screen.getByRole("alert").textContent).toContain("Showing the last loaded records");
});
it("distinguishes a successful empty response from a filter with no matches", () => {
  const { props, rerender } = renderCard();
  expect(screen.getByText("No recent runtime records were returned.")).toBeTruthy();
  rerender(<AdminRuntimeCard {...props} runtimeSessions={[session(1)]} />);
  fireEvent.click(screen.getByRole("button", { name: "Terminated" }));
  expect(screen.getByText(/No records match these filters/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(rows()).toEqual(["session-1"]);
});
it("keeps a configuration error local and does not treat a missing platform key as unhealthy", () => {
  const { props, rerender } = renderCard({ configError: "Configuration offline", runtimeSessions: [session(1)] });
  fireEvent.click(screen.getByText("Backend configuration"));
  fireEvent.click(screen.getByRole("button", { name: "Reload configuration" }));
  expect(props.onRetryConfig).toHaveBeenCalledTimes(1);
  expect(rows()).toEqual(["session-1"]);
  rerender(<AdminRuntimeCard {...props} configError={null} runtimeConfig={{ e2bTemplateId: "", platformProviders: ["anthropic"] }} />);
  expect(screen.getByText("OpenAI platform key not set")).toBeTruthy();
  expect(screen.getByText(/does not test provider health/)).toBeTruthy();
  expect(screen.queryByText(/key missing/)).toBeNull();
});
it.each([["Drain idle", "onDrainIdle"], ["Refresh idle", "onRefreshIdle"]] as const)("reviews %s before any request and returns focus on close", async (label, handler) => {
  const { props } = renderCard();
  const trigger = screen.getByRole("button", { name: label });
  trigger.focus(); fireEvent.click(trigger);
  expect(props.onDrainIdle).not.toHaveBeenCalled(); expect(props.onRefreshIdle).not.toHaveBeenCalled();
  expect(screen.getByText(/Files created in those workspaces must be recreated/)).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: `Review ${label}` })));
  expect(document.activeElement?.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  fireEvent.click(screen.getByRole("button", { name: "Reset idle workspaces" }));
  expect(props[handler]).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Close review" }));
  expect(document.activeElement).toBe(trigger);
});
it("keeps the confirmation mounted and focused during pending and shows the returned count including zero", async () => {
  const { props, rerender } = renderCard();
  fireEvent.click(screen.getByRole("button", { name: "Refresh idle" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review Refresh idle" })));
  const confirm = screen.getByRole("button", { name: "Reset idle workspaces" }); confirm.focus();
  rerender(<AdminRuntimeCard {...props} busyKey="refresh" />);
  fireEvent.click(confirm);
  expect(props.onRefreshIdle).not.toHaveBeenCalled();
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(confirm);
  rerender(<AdminRuntimeCard {...props} rolloutResult={{ action: "refresh_idle", affectedSessionIds: [] }} />);
  expect(screen.getByRole("status").textContent).toContain("No idle runtimes were reset");
  expect(confirm.getAttribute("aria-describedby")).toBe(screen.getByRole("status").id);
  rerender(<AdminRuntimeCard {...props} rolloutResult={{ action: "refresh_idle", affectedSessionIds: ["a", "b"] }} />);
  expect(screen.getByRole("status").textContent).toContain("for 2 sessions");
});
it("paginates the returned sample and resets pagination after a filter change", () => {
  renderCard({ runtimeSessions: Array.from({ length: 25 }, (_, i) => session(i)) });
  expect(rows()).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "Show all 25 records" }));
  expect(rows()).toHaveLength(25);
  fireEvent.click(screen.getByRole("button", { name: "Active" }));
  expect(rows()).toHaveLength(20);
});
