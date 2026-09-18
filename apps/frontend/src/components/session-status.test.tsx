// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStatusIndicator } from "./session-status";
import { formatTurnElapsed, resolveSessionStatus } from "./session-status.logic";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("prioritizes approval, failure, running, then ready", () => {
  expect(resolveSessionStatus({ pendingApproval: true, failed: true, running: true })).toBe("approval");
  expect(resolveSessionStatus({ failed: true, running: true })).toBe("failed");
  expect(resolveSessionStatus({ running: true })).toBe("running");
  expect(resolveSessionStatus({})).toBe("ready");
});

it("ticks from the original start and removes the timer while waiting or settled", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:59Z"));
  const startedAt = "2026-09-13T12:00:00Z";
  const view = render(<SessionStatusIndicator status="running" startedAt={startedAt} />);
  expect(screen.getByText("Running for 59s")).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByText("Running for 1m 00s")).toBeTruthy();
  view.rerender(<SessionStatusIndicator status="approval" startedAt={startedAt} />);
  expect(screen.queryByText(/Running for/)).toBeNull();
  expect(screen.getByRole("img", { name: "Waiting for approval" }).parentElement?.title).toBe("Waiting for approval");
  expect(vi.getTimerCount()).toBe(0);
  act(() => { vi.advanceTimersByTime(24000); });
  view.rerender(<SessionStatusIndicator status="running" startedAt={startedAt} />);
  expect(screen.getByText("Running for 1m 24s")).toBeTruthy();
  view.rerender(<SessionStatusIndicator status="failed" startedAt={startedAt} showLabel />);
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(<SessionStatusIndicator status="ready" />);
  expect(screen.getByRole("img", { name: "Ready" })).toBeTruthy();
});

it("clamps future clocks and formats long turns", () => {
  expect(formatTurnElapsed("2026-09-13T12:00:00Z", Date.parse("2026-09-13T11:59:00Z"))).toBe("0s");
  expect(formatTurnElapsed("invalid", 0)).toBeNull();
  expect(formatTurnElapsed("2026-09-13T12:00:00Z", Date.parse("2026-09-13T12:12:03Z"))).toBe("12m 03s");
});

it("overrides stale running polls after settlement but accepts a later server turn", async () => {
  const { applyLiveTurn } = await import("./session-status.logic");
  const session = {
    sessionId: "s", userId: "u", sessionName: "Research", status: "active" as const,
    createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z",
    latestTurnId: "turn-10", latestTurnSequence: 10,
    isRunning: true, activeTurnStartedAt: "2026-09-13T12:00:01Z"
  };
  const activity = { turnId: "turn-10", turnSequence: 10, startedAt: "2026-09-13T12:00:00Z", isRunning: true, failed: false };
  expect(applyLiveTurn(session, activity).session.activeTurnStartedAt).toBe(activity.startedAt);
  expect(applyLiveTurn({ ...session, activeTurnStartedAt: "2026-09-13T11:00:00Z" }, activity).session.activeTurnStartedAt).toBe(activity.startedAt);
  const settled = { ...activity, isRunning: false, settledAt: "2026-09-13T12:00:10Z" };
  expect(applyLiveTurn(session, settled)).toMatchObject({ applied: true, session: { isRunning: false, activeTurnStartedAt: undefined } });
  const later = { ...session, latestTurnId: "turn-11", latestTurnSequence: 11, activeTurnStartedAt: "2026-09-13T12:00:20Z" };
  expect(applyLiveTurn(later, settled)).toEqual({ session: later, applied: false });
});

it("shows unavailable timing instead of a fabricated zero for invalid timestamps", () => {
  render(<SessionStatusIndicator status="running" startedAt="invalid" />);
  expect(screen.getByText("Running · time unavailable")).toBeTruthy();
  expect(screen.queryByText("Running for 0s")).toBeNull();
});


it.each(["2026-09-13T12:02:00Z", "2026-09-13T11:58:00Z"])("orders turns independently of the browser clock at %s", async (startedAt) => {
  const { applyLiveTurn } = await import("./session-status.logic");
  const previous = { turnId: "old", turnSequence: 10, startedAt, isRunning: false, failed: true };
  const session = {
    sessionId: "s", userId: "u", sessionName: "Research", status: "active" as const,
    createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z",
    latestTurnId: "new", latestTurnSequence: 11, isRunning: true,
    activeTurnStartedAt: "2026-09-13T12:00:30Z", hasTurnFailed: false
  };
  expect(applyLiveTurn(session, previous)).toEqual({ session, applied: false });
  const completed = { ...session, isRunning: false, activeTurnStartedAt: undefined };
  expect(applyLiveTurn(completed, previous)).toEqual({ session: completed, applied: false });
  const stale = { ...session, latestTurnId: "older", latestTurnSequence: 9 };
  expect(applyLiveTurn(stale, previous)).toMatchObject({ applied: true, session: { isRunning: false, hasTurnFailed: true } });
});

it.each([
  ["completed", "ready", "Worked for 1m 24s"],
  ["error", "failed", "Failed after 1m 24s"],
  ["interrupted", "ready", "Stopped after 1m 24s"]
] as const)("keeps %s duration fixed and replaces it on a new run", (outcome, status, label) => {
  vi.useFakeTimers();
  const completedTurn = { durationMs: 84000, status: outcome };
  const view = render(<SessionStatusIndicator status={status} completedTurn={completedTurn} showLabel />);
  expect(screen.getByText(label)).toBeTruthy();
  act(() => { vi.advanceTimersByTime(10000); });
  expect(screen.getByText(label)).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(<SessionStatusIndicator status="running" startedAt={new Date().toISOString()} completedTurn={completedTurn} />);
  expect(screen.queryByText(label)).toBeNull();
  expect(screen.getByText("Running for 0s")).toBeTruthy();
  view.rerender(<SessionStatusIndicator status="approval" completedTurn={completedTurn} showLabel />);
  expect(screen.queryByText(label)).toBeNull();
  expect(screen.getByText("Waiting for approval")).toBeTruthy();
});

it("uses only the latest known settled turn and leaves unknown timing absent", async () => {
  const { latestCompletedTurn } = await import("./session-status.logic");
  const session = { sessionId: "s", latestTurnId: "m" } as import("@cogniplane/shared-types").Session;
  const message = { sessionId: "s", messageId: "m", role: "assistant", status: "completed", durationMs: 84000 } as import("@cogniplane/shared-types").Message;
  const activity = { turnId: "m", isRunning: false, failed: false, startedAt: "" };
  expect(latestCompletedTurn([message], session, null)).toEqual({ durationMs: 84000, status: "completed" });
  expect(latestCompletedTurn([message], session, activity)).toEqual({ durationMs: 84000, status: "completed" });
  for (const durationMs of [undefined, null, -1, NaN, Infinity]) {
    expect(latestCompletedTurn([{ ...message, durationMs }], session, null)).toBeUndefined();
  }
  expect(latestCompletedTurn([message], { ...session, isRunning: true }, null)).toBeUndefined();
  expect(latestCompletedTurn([message], session, { ...activity, turnId: "next" })).toBeUndefined();
  expect(latestCompletedTurn([message], { ...session, latestTurnId: "next" }, null)).toBeUndefined();
  expect(latestCompletedTurn([message, { ...message, role: "user" }], session, null)).toBeUndefined();
  expect(latestCompletedTurn([{ ...message, status: "streaming" }], session, null)).toBeUndefined();
  expect(latestCompletedTurn([message], { ...session, sessionId: "other" }, null)).toBeUndefined();
});

it.each([
  ["ready", "error", "Failed", "Failed after 1m 24s", "text-danger"],
  ["failed", "completed", "Ready", "Worked for 1m 24s", "text-on-surface-variant"],
  ["failed", "interrupted", "Ready", "Stopped after 1m 24s", "text-on-surface-variant"]
] as const)("uses the settled %s/%s outcome for both icon and label", (status, outcome, iconLabel, text, color) => {
  render(<SessionStatusIndicator status={status} completedTurn={{ status: outcome, durationMs: 84000 }} showLabel />);
  const icon = screen.getByRole("img", { name: iconLabel });
  expect(icon.parentElement?.classList.contains(color)).toBe(true);
  expect(screen.getByText(text)).toBeTruthy();
});
