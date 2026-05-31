import { test, expect, vi } from "vitest";

import { createRecentlyResolvedCache } from "./approvals.js";

test("recently-resolved cache returns true for the same tenant and approval", () => {
  const cache = createRecentlyResolvedCache(60_000);
  cache.remember("tenant-a", "approval-1");
  expect(cache.wasRecentlyResolved("tenant-a", "approval-1")).toBe(true);
});

test("recently-resolved cache does not leak across tenants on the same approval id", () => {
  const cache = createRecentlyResolvedCache(60_000);
  cache.remember("tenant-a", "approval-1");
  // Tenant B probing the exact same approvalId must NOT get a positive
  // "resolved" signal — that's the cross-tenant leak the fix closes.
  expect(cache.wasRecentlyResolved("tenant-b", "approval-1")).toBe(false);
});

test("recently-resolved cache treats non-existent entries as not recently resolved", () => {
  const cache = createRecentlyResolvedCache(60_000);
  expect(cache.wasRecentlyResolved("tenant-a", "missing")).toBe(false);
});

test("recently-resolved cache evicts expired entries", () => {
  // Drive the TTL deterministically off a frozen clock instead of racing a
  // real 1ms timer — the cache reads Date.now(), so advancing fake time past
  // the TTL is the observable expiry signal.
  vi.useFakeTimers();
  try {
    const cache = createRecentlyResolvedCache(1_000);
    cache.remember("tenant-a", "approval-1");
    expect(cache.wasRecentlyResolved("tenant-a", "approval-1")).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(cache.wasRecentlyResolved("tenant-a", "approval-1")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("recently-resolved cache key is composite, not just approvalId", () => {
  const cache = createRecentlyResolvedCache(60_000);
  cache.remember("tenant-a", "shared");
  cache.remember("tenant-b", "shared");
  // Both tenants independently see their own resolution.
  expect(cache.wasRecentlyResolved("tenant-a", "shared")).toBe(true);
  expect(cache.wasRecentlyResolved("tenant-b", "shared")).toBe(true);
  // A third tenant still gets no signal.
  expect(cache.wasRecentlyResolved("tenant-c", "shared")).toBe(false);
});
