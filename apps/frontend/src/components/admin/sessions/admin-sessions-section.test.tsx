// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSessionRow } from "@cogniplane/shared-types";

import { AdminSessionsSection } from "./admin-sessions-section";

afterEach(cleanup);

function row(overrides: Partial<AdminSessionRow> = {}): AdminSessionRow {
  return {
    sessionId: "s1", userId: "u1", userEmail: "ana@example.com", createdAt: "2026-10-01T10:00:00.000Z",
    lastActivityAt: "2026-10-01T11:00:00.000Z", messageCount: 2, runtimeProvider: "deep-agents",
    modelName: "Claude Sonnet 5", status: "active", alerts: [], skillsUsedCount: 2, mcpServersUsedCount: 1,
    ...overrides
  };
}

it("shows placeholders while loading", () => {
  const { container } = render(<AdminSessionsSection sessions={[]} isLoading />);

  expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
});

it("shows a hint when there are no sessions", () => {
  render(<AdminSessionsSection sessions={[]} isLoading={false} />);

  expect(screen.getByText(/No sessions found/)).toBeTruthy();
  expect(screen.getByText("Showing 0 sessions")).toBeTruthy();
});

it("summarizes each session with singular and plural counts", () => {
  render(<AdminSessionsSection
    sessions={[
      row(),
      row({ sessionId: "s2", userEmail: null, userId: "u2", modelName: null, status: "errored", messageCount: 1, skillsUsedCount: 1 })
    ]}
    isLoading={false}
    hasMore
  />);

  expect(screen.getByText("Showing 2 sessions+")).toBeTruthy();
  expect(screen.getByText("ana@example.com")).toBeTruthy();
  // Without an email, the user id stands in.
  expect(screen.getByText("u2")).toBeTruthy();
  expect(screen.getByText("Claude Sonnet 5")).toBeTruthy();
  expect(screen.getByText("2 skills")).toBeTruthy();
  expect(screen.getByText("1 skill")).toBeTruthy();
  expect(screen.getByText(/^2 messages · started/)).toBeTruthy();
  expect(screen.getByText(/^1 message · started/)).toBeTruthy();
  expect(screen.getByText("errored")).toBeTruthy();
});

it("opens a session by click, Enter, or Space when rows are interactive", () => {
  const onRowClick = vi.fn();
  render(<AdminSessionsSection sessions={[row()]} isLoading={false} onRowClick={onRowClick} />);
  const button = screen.getByRole("button", { name: /ana@example.com/ });

  fireEvent.click(button);
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.keyDown(button, { key: " " });
  fireEvent.keyDown(button, { key: "a" });

  expect(onRowClick.mock.calls).toEqual([["s1"], ["s1"], ["s1"]]);
});

it("renders plain rows without a click handler", () => {
  render(<AdminSessionsSection sessions={[row()]} isLoading={false} />);

  expect(screen.getByText("ana@example.com")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /ana@example.com/ })).toBeNull();
});

it("shows alerts and loads more on request", () => {
  const onLoadMore = vi.fn();
  render(<AdminSessionsSection
    sessions={[row({ alerts: [{ kind: "pii-blocked", count: 2 }] })]}
    isLoading={false}
    hasMore
    onLoadMore={onLoadMore}
  />);

  expect(screen.getByText(/PII blocked/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(onLoadMore).toHaveBeenCalledTimes(1);
});

it("disables Load more while the next page loads", () => {
  render(<AdminSessionsSection sessions={[row()]} isLoading={false} hasMore onLoadMore={vi.fn()} isLoadingMore />);
  expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(true);
});
