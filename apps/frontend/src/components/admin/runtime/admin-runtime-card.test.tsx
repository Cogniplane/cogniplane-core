// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminRuntimeConfig, RuntimeSessionSummary } from "@cogniplane/shared-types";
import { MODEL_PROVIDER_META } from "@cogniplane/shared-types";

import { PILL_GREEN, PILL_RED } from "../../../lib/ui-tokens";
import { AdminRuntimeCard } from "./admin-runtime-card";

afterEach(cleanup);

function session(i: number, overrides: Partial<RuntimeSessionSummary> = {}): RuntimeSessionSummary {
  return {
    sessionId: `session-${i}`, runtimeId: `runtime-${i}`, status: "active", healthStatus: "healthy",
    startedAt: null, lastActiveAt: null, updatedAt: "2026-10-01T10:00:00.000Z", runtimeProvider: "deep-agents",
    configSummary: {
      manifestHash: "m", configBundleHash: "c", runtimePolicy: { id: "default", version: 3, hash: "p" },
      skillVersions: [{ id: "pdf", version: 1, hash: "s" }], mcpServerVersions: []
    },
    ...overrides
  };
}

function renderCard(props: Partial<Parameters<typeof AdminRuntimeCard>[0]> = {}) {
  const handlers = { onDrainIdle: vi.fn(), onRefreshIdle: vi.fn() };
  render(<AdminRuntimeCard runtimeSessions={[]} runtimeConfig={null} busyKey={null} {...handlers} {...props} />);
  return handlers;
}

const rows = () => screen.queryAllByText(/^session-\d+$/).map((element) => element.textContent);

it("counts active and tracked sessions and describes each one", () => {
  renderCard({ runtimeSessions: [session(1), session(2, { status: "stopped", healthStatus: "error", runtimeProvider: null })] });

  expect(screen.getByText("1 active")).toBeTruthy();
  expect(screen.getByText("2 tracked")).toBeTruthy();
  expect(screen.getAllByText("policy default v3")).toHaveLength(2);
  expect(screen.getAllByText("1 skills pinned")).toHaveLength(2);
  expect(screen.getByText("healthy").className).toBe(PILL_GREEN);
  expect(screen.getByText("error").className).toBe(PILL_RED);
  // Only the session with a runtime provider names it.
  expect(screen.getAllByText("deep-agents")).toHaveLength(1);
  expect(screen.getAllByText("Started n/a")).toHaveLength(2);
});

it("shows which platform provider keys are set", () => {
  const runtimeConfig: AdminRuntimeConfig = { e2bTemplateId: "", platformProviders: ["anthropic"] };
  renderCard({ runtimeConfig });

  expect(screen.getByText(`${MODEL_PROVIDER_META.anthropic.label} key set`)).toBeTruthy();
  expect(screen.getByText(`${MODEL_PROVIDER_META.openai.label} key missing`)).toBeTruthy();
  // An empty template id shows a dash rather than nothing.
  expect(screen.getByText("—")).toBeTruthy();
});

it("runs the rollouts", () => {
  const { onDrainIdle, onRefreshIdle } = renderCard();

  fireEvent.click(screen.getByRole("button", { name: "Drain idle" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh idle" }));

  expect([onDrainIdle.mock.calls.length, onRefreshIdle.mock.calls.length]).toEqual([1, 1]);
});

// Both rollouts share one request state, so a second one would hide the first one's result.
it.each([
  ["drain", "Draining...", "Refresh idle"],
  ["refresh", "Refreshing...", "Drain idle"]
])("labels the %s rollout and blocks both rollouts while it runs", (busyKey, busyLabel, otherLabel) => {
  renderCard({ busyKey });

  expect((screen.getByRole("button", { name: busyLabel }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: otherLabel }) as HTMLButtonElement).disabled).toBe(true);
});

it("filters by text and status", () => {
  renderCard({ runtimeSessions: [session(1), session(2, { status: "stopped" }), session(13)] });

  fireEvent.change(screen.getByLabelText("Filter by session or runtime ID"), { target: { value: "session-1" } });
  expect(rows()).toEqual(["session-1", "session-13"]);

  fireEvent.click(screen.getByRole("button", { name: "stopped" }));
  expect(screen.getByText("No sessions match the current filter.")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Filter by session or runtime ID"), { target: { value: "" } });
  expect(rows()).toEqual(["session-2"]);
});

it("shows 20 sessions at first, and all of them on request until the filter changes", () => {
  renderCard({ runtimeSessions: Array.from({ length: 25 }, (_, i) => session(i)) });
  expect(rows()).toHaveLength(20);

  fireEvent.click(screen.getByRole("button", { name: "Show all 25 sessions" }));
  expect(rows()).toHaveLength(25);
  expect(screen.getByRole("button", { name: "Show fewer (20 of 25)" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "active" }));
  expect(rows()).toHaveLength(20);

  fireEvent.click(screen.getByRole("button", { name: "Show all 25 sessions" }));
  fireEvent.change(screen.getByLabelText("Filter by session or runtime ID"), { target: { value: "session" } });
  expect(rows()).toHaveLength(20);
});
