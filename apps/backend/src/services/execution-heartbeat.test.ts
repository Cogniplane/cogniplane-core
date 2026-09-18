import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startExecutionHeartbeat } from "./execution-heartbeat.js";

beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] }));
afterEach(() => vi.useRealTimers());
function setup() {
  const renew = vi.fn(async () => true);
  const onLost = vi.fn(async () => {});
  const onError = vi.fn();
  const stop = startExecutionHeartbeat({ leaseStartedAt: performance.now(), leaseMs: 30_000, intervalMs: 5_000, renew, onLost, onError });
  return { renew, onLost, onError, stop };
}
it("survives two query failures then renews within the confirmed lease", async () => {
  const h = setup();
  h.renew.mockRejectedValueOnce(new Error("database unavailable")).mockRejectedValueOnce(new Error("database unavailable"));
  await vi.advanceTimersByTimeAsync(35_000);
  expect(h.onError).toHaveBeenCalledTimes(2);
  expect(h.onLost).not.toHaveBeenCalled();
  expect(h.renew).toHaveBeenCalledTimes(7);
  h.stop();
});
it("stops immediately on confirmed revocation and never polls again", async () => {
  const h = setup();
  h.renew.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.onLost).toHaveBeenCalledTimes(1);
  expect(h.renew).toHaveBeenCalledTimes(1);
});
it("bounds repeated query failures by the last confirmed lease", async () => {
  const h = setup();
  h.renew.mockRejectedValue(new Error("database unavailable"));
  await vi.advanceTimersByTimeAsync(29_999);
  expect(h.onLost).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.onLost).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.renew).toHaveBeenCalledTimes(5);
});
it("expires even when a query hangs and ignores its late success", async () => {
  const h = setup();
  let resolve!: (current: boolean) => void;
  h.renew.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.onLost).toHaveBeenCalledTimes(1);
  resolve(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.renew).toHaveBeenCalledTimes(1);
  expect(h.onLost).toHaveBeenCalledTimes(1);
});
it("ignores an in-flight result after normal turn cleanup", async () => {
  const h = setup();
  let resolve!: (current: boolean) => void;
  h.renew.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await vi.advanceTimersByTimeAsync(5_000);
  h.stop();
  resolve(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.onLost).not.toHaveBeenCalled();
  expect(h.renew).toHaveBeenCalledTimes(1);
});
it("does not add acquisition latency or interval rounding to the initial deadline", async () => {
  const leaseStartedAt = performance.now();
  await vi.advanceTimersByTimeAsync(2_345);
  const onLost = vi.fn(async () => {});
  const renew = vi.fn(async () => { throw new Error("database unavailable"); });
  startExecutionHeartbeat({ leaseStartedAt, leaseMs: 30_000, intervalMs: 5_000, renew, onLost, onError: vi.fn() });
  await vi.advanceTimersByTimeAsync(27_654);
  expect(onLost).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onLost).toHaveBeenCalledTimes(1);
});

it("uses the database expiry after admission latency", async () => {
  const leaseStartedAt = performance.now();
  await vi.advanceTimersByTimeAsync(2_345);
  const onLost = vi.fn(async () => {});
  const renew = vi.fn(async () => { throw new Error("database unavailable"); });
  startExecutionHeartbeat({
    leaseStartedAt,
    leaseExpiresAt: performance.now() + 30_000,
    leaseMs: 30_000,
    intervalMs: 5_000,
    renew,
    onLost,
    onError: vi.fn()
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(onLost).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onLost).toHaveBeenCalledTimes(1);
});
