import { afterEach, expect, test, vi } from "vitest";

import {
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_MARGIN_MS,
  SHUTDOWN_STAGE_MS,
  shutdownStageSumMs,
  waitWithinBudget
} from "./shutdown-budget.js";

afterEach(() => {
  vi.useRealTimers();
});

test("the hard deadline is longer than the sum of the stage limits", () => {
  const sum = Object.values(SHUTDOWN_STAGE_MS).reduce((total, ms) => total + ms, 0);
  expect(Object.values(SHUTDOWN_STAGE_MS).every((ms) => ms > 0)).toBe(true);
  expect(SHUTDOWN_MARGIN_MS).toBeGreaterThan(0);
  expect(shutdownStageSumMs()).toBe(sum);
  expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(sum);
});

test("waitWithinBudget returns true when the task ends in time", async () => {
  await expect(waitWithinBudget(Promise.resolve("done"), 1_000)).resolves.toBe(true);
});

test("waitWithinBudget returns false at the limit and ignores a later failure", async () => {
  vi.useFakeTimers();
  let fail!: (error: Error) => void;
  const task = new Promise<void>((_resolve, reject) => { fail = reject; });

  const waited = waitWithinBudget(task, 100);
  await vi.advanceTimersByTimeAsync(100);

  await expect(waited).resolves.toBe(false);
  // No unhandled rejection: the failure arrives after the waiter stopped.
  fail(new Error("late failure"));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("waitWithinBudget rejects when the task fails before the limit", async () => {
  await expect(waitWithinBudget(Promise.reject(new Error("close failed")), 1_000)).rejects.toThrow("close failed");
});
