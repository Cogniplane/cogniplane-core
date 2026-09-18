import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveTurnsRegistry, deriveStaleAfterMs } from "./active-turns-registry.js";

describe("deriveStaleAfterMs", () => {
  it("follows whichever wall-clock cap is larger, plus a margin", () => {
    // The stale window must sit above the longest a turn can still be live, or
    // snapshot() evicts a running turn and a second turn starts on the session.
    expect(
      deriveStaleAfterMs({ E2B_SANDBOX_TIMEOUT_MS: 30 * 60_000, TOOL_CONTEXT_TTL_MS: 35 * 60_000 })
    ).toBe(40 * 60_000);
    expect(
      deriveStaleAfterMs({ E2B_SANDBOX_TIMEOUT_MS: 60 * 60_000, TOOL_CONTEXT_TTL_MS: 35 * 60_000 })
    ).toBe(65 * 60_000);
  });

  it("tracks an operator raising either timer past the old hard-coded 35 min", () => {
    // The regression this replaces: a constant that happened to clear the
    // defaults, then silently under-shot once a timer was raised by env.
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

  it("clears a turn explicitly", () => {
    const registry = new ActiveTurnsRegistry();
    registry.mark("s1");
    expect(registry.snapshot().has("s1")).toBe(true);
    registry.clear("s1");
    expect(registry.snapshot().has("s1")).toBe(false);
    expect(registry.startedAt("s1")).toBeUndefined();
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
