import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearIdleTimer, scheduleIdleTeardown, type IdleTimerHost } from "./idle-teardown.js";

describe("idle-teardown", () => {
  const logger = { error: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    logger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeHost(): IdleTimerHost {
    return { idleTimer: null };
  }

  it("fires onIdle after the timeout when not busy", async () => {
    const host = makeHost();
    const onIdle = vi.fn().mockResolvedValue(undefined);

    scheduleIdleTeardown(host, {
      timeoutMs: 1000,
      isBusy: () => false,
      onIdle,
      logger,
      logContext: { sessionId: "s1" }
    });

    expect(host.idleTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(host.idleTimer).toBeNull();
  });

  it("does not arm while busy", () => {
    const host = makeHost();
    scheduleIdleTeardown(host, {
      timeoutMs: 1000,
      isBusy: () => true,
      onIdle: vi.fn(),
      logger,
      logContext: {}
    });
    expect(host.idleTimer).toBeNull();
  });

  it("re-arming replaces the previous timer instead of stacking", async () => {
    const host = makeHost();
    const onIdle = vi.fn().mockResolvedValue(undefined);
    const opts = { timeoutMs: 1000, isBusy: () => false, onIdle, logger, logContext: {} };

    scheduleIdleTeardown(host, opts);
    await vi.advanceTimersByTimeAsync(500);
    scheduleIdleTeardown(host, opts);
    await vi.advanceTimersByTimeAsync(999);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("clearIdleTimer cancels a scheduled teardown", async () => {
    const host = makeHost();
    const onIdle = vi.fn().mockResolvedValue(undefined);

    scheduleIdleTeardown(host, {
      timeoutMs: 1000,
      isBusy: () => false,
      onIdle,
      logger,
      logContext: {}
    });
    clearIdleTimer(host);

    expect(host.idleTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("logs instead of throwing when onIdle rejects", async () => {
    const host = makeHost();
    scheduleIdleTeardown(host, {
      timeoutMs: 1000,
      isBusy: () => false,
      onIdle: () => Promise.reject(new Error("teardown blew up")),
      logger,
      logContext: { sessionId: "s1" }
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", err: expect.any(Error) }),
      "idle teardown failed"
    );
  });
});
