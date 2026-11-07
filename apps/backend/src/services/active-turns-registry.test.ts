import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveTurnsRegistry, deriveStaleAfterMs } from "./active-turns-registry.js";

describe("deriveStaleAfterMs", () => {
  it("follows whichever wall-clock cap is larger, plus a margin", () => {
    expect(
      deriveStaleAfterMs({ E2B_SANDBOX_TIMEOUT_MS: 30 * 60_000, TOOL_CONTEXT_TTL_MS: 35 * 60_000 })
    ).toBe(40 * 60_000);
    expect(
      deriveStaleAfterMs({ E2B_SANDBOX_TIMEOUT_MS: 60 * 60_000, TOOL_CONTEXT_TTL_MS: 35 * 60_000 })
    ).toBe(65 * 60_000);
  });

  it("tracks an operator raising either timer past the old hard-coded 35 min", () => {
    // A constant that fits the defaults would under-shoot after an env override.
    const staleAfterMs = deriveStaleAfterMs({
      E2B_SANDBOX_TIMEOUT_MS: 90 * 60_000,
      TOOL_CONTEXT_TTL_MS: 35 * 60_000
    });
    expect(staleAfterMs).toBeGreaterThan(90 * 60_000);
  });
});

describe("ActiveTurnsRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a turn visible right up to the stale window and drops it after", () => {
    const staleAfterMs = 40 * 60_000;
    const registry = new ActiveTurnsRegistry(staleAfterMs);
    const start = Date.now();
    registry.mark("s1");
    expect(registry.startedAt("s1")).toBe(start);

    // A turn one minute short of the window is still live and must stay busy.
    vi.setSystemTime(start + staleAfterMs - 60_000);
    expect(registry.snapshot().has("s1")).toBe(true);

    vi.setSystemTime(start + staleAfterMs + 1);
    expect(registry.snapshot().has("s1")).toBe(false);
    expect(registry.startedAt("s1")).toBeUndefined();
  });

  it("survives consecutive approval rounds that each land inside the window", () => {
    // Staleness counts from the last keepalive, not from the start. Approval
    // rounds are unbounded, so a turn can outlast the window.
    const staleAfterMs = 40 * 60_000;
    const registry = new ActiveTurnsRegistry(staleAfterMs);
    const start = Date.now();
    registry.mark("s1");

    // Round one resolves 30 minutes in: still inside the window, so the entry
    // is live and the keepalive refreshes it.
    vi.setSystemTime(start + 30 * 60_000);
    expect(registry.snapshot().has("s1")).toBe(true);
    registry.keepAlive("s1");

    // Round two resolves 30 minutes after that. Total elapsed is 60 minutes,
    // well past the 40-minute window, but each round stayed inside it.
    vi.setSystemTime(start + 60 * 60_000);
    expect(registry.snapshot().has("s1")).toBe(true);
    expect(registry.isBusy("s1")).toBe(true);
  });

  it("keeps the turn's start time fixed across keepalives", () => {
    // startedAt drives the user-visible elapsed timer. Refreshing it on an
    // approval would make the timer jump backwards mid-turn.
    const registry = new ActiveTurnsRegistry(40 * 60_000);
    const start = Date.now();
    registry.mark("s1");

    vi.setSystemTime(start + 5 * 60_000);
    registry.keepAlive("s1");

    expect(registry.startedAt("s1")).toBe(start);
  });

  it("still evicts a turn whose round overruns the window", () => {
    // The keepalive makes the window an idle timeout between rounds, not a
    // lease. A single round that runs past the window is still dead.
    const staleAfterMs = 40 * 60_000;
    const registry = new ActiveTurnsRegistry(staleAfterMs);
    const start = Date.now();
    registry.mark("s1");

    vi.setSystemTime(start + staleAfterMs + 1);
    expect(registry.snapshot().has("s1")).toBe(false);
  });

  it("does not resurrect a cleared turn", () => {
    // Reserving a cleared session again would block every later turn on it.
    const registry = new ActiveTurnsRegistry();
    registry.mark("s1");
    registry.clear("s1");

    registry.keepAlive("s1");

    expect(registry.snapshot().has("s1")).toBe(false);
    expect(registry.isBusy("s1")).toBe(false);
    expect(registry.startedAt("s1")).toBeUndefined();
  });

  it("clears a turn explicitly", () => {
    const registry = new ActiveTurnsRegistry();
    registry.mark("s1");
    expect(registry.snapshot().has("s1")).toBe(true);
    registry.clear("s1");
    expect(registry.snapshot().has("s1")).toBe(false);
    expect(registry.startedAt("s1")).toBeUndefined();
  });

  it("signals a setup turn only for its tenant", () => {
    const registry = new ActiveTurnsRegistry();
    registry.mark("s1", { tenantId: "tenant-a", userId: "user-a" });
    expect(registry.requestCancel("s1", "tenant-b")).toBe(false);
    expect(registry.cancelSignal("s1")?.aborted).toBe(false);
    expect(registry.requestCancel("s1", "tenant-a")).toBe(true);
    expect(registry.cancelSignal("s1")?.aborted).toBe(true);
    registry.clear("s1");
    expect(registry.requestCancel("s1", "tenant-a")).toBe(false);
  });

  it("does not let an old request close the next turn's event log", () => {
    const registry = new ActiveTurnsRegistry();
    const first = registry.mark("s1", { tenantId: "tenant-a", userId: "user-a" });
    registry.clear("s1");
    const second = registry.mark("s1", { tenantId: "tenant-a", userId: "user-a" });

    registry.closeEventLog("s1", first);

    expect(first.subscribe(0, () => undefined)).toBeNull();
    expect(registry.eventLog("s1", "tenant-a")).toBe(second);
    expect(second.subscribe(0, () => undefined)).not.toBeNull();
  });
});

it("reserves mutations without reporting turns and releases only its own reservation", () => {
  const registry = new ActiveTurnsRegistry();
  const release = registry.reserveMutation("s1")!;
  expect(registry.isBusy("s1")).toBe(true);
  expect(registry.snapshot().size).toBe(0);
  expect(registry.startedAt("s1")).toBeUndefined();
  expect(registry.reserveMutation("s1")).toBeNull();
  release();
  const releaseNext = registry.reserveMutation("s1")!;
  release();
  expect(registry.isBusy("s1")).toBe(true);
  registry.mark("s1");
  releaseNext();
  expect(registry.snapshot().has("s1")).toBe(true);
  expect(registry.reserveMutation("s1")).toBeNull();
});
