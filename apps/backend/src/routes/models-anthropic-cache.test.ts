import { test, expect } from "vitest";

import {
  createAnthropicCapabilitiesCache,
  type AnthropicEffortCapabilities
} from "./models-anthropic-cache.js";

function makeCapabilities(modelId: string): AnthropicEffortCapabilities {
  return new Map([
    [modelId, { supportedEfforts: ["high"], defaultEffort: "high" }]
  ]);
}

test("getOrLoad: invokes loader once on miss, then serves cached value within TTL", async () => {
  let calls = 0;
  const now = 1_000;
  const cache = createAnthropicCapabilitiesCache({
    successTtlMs: 100,
    negativeTtlMs: 10,
    now: () => now
  });

  const first = await cache.getOrLoad("tenant-1", async () => {
    calls += 1;
    return makeCapabilities("claude-x");
  });
  const second = await cache.getOrLoad("tenant-1", async () => {
    calls += 1;
    return makeCapabilities("never-called");
  });

  expect(calls).toBe(1);
  expect(first?.has("claude-x")).toBe(true);
  expect(second?.has("claude-x")).toBe(true);
});

test("getOrLoad: re-invokes loader after the success TTL elapses", async () => {
  let calls = 0;
  let now = 1_000;
  const cache = createAnthropicCapabilitiesCache({
    successTtlMs: 100,
    negativeTtlMs: 10,
    now: () => now
  });

  await cache.getOrLoad("tenant-1", async () => {
    calls += 1;
    return makeCapabilities("a");
  });
  now += 101;
  await cache.getOrLoad("tenant-1", async () => {
    calls += 1;
    return makeCapabilities("b");
  });

  expect(calls).toBe(2);
});

test("getOrLoad: caches negative outcomes with the shorter negative TTL", async () => {
  let calls = 0;
  let now = 1_000;
  const cache = createAnthropicCapabilitiesCache({
    successTtlMs: 100_000,
    negativeTtlMs: 50,
    now: () => now
  });

  const first = await cache.getOrLoad("tenant-1", async () => {
    calls += 1;
    return null;
  });
  // Within the negative window: skip the loader.
  const second = await cache.getOrLoad("tenant-1", async () => {
    calls += 1;
    return makeCapabilities("a");
  });
  // Past the negative window: re-attempt.
  now += 51;
  const third = await cache.getOrLoad("tenant-1", async () => {
    calls += 1;
    return makeCapabilities("a");
  });

  expect(first).toBeNull();
  expect(second).toBeNull();
  expect(third?.has("a")).toBe(true);
  expect(calls).toBe(2);
});

test("getOrLoad: keys are scoped per tenant — one tenant's hit does not satisfy another", async () => {
  let calls = 0;
  const cache = createAnthropicCapabilitiesCache({
    successTtlMs: 1_000,
    negativeTtlMs: 1_000
  });

  await cache.getOrLoad("tenant-1", async () => {
    calls += 1;
    return makeCapabilities("a");
  });
  await cache.getOrLoad("tenant-2", async () => {
    calls += 1;
    return makeCapabilities("b");
  });

  expect(calls).toBe(2);
});

test("getOrLoad: concurrent requests on a cold key share a single inflight load", async () => {
  let calls = 0;
  let resolveLoader: (value: AnthropicEffortCapabilities | null) => void = () => {};
  const cache = createAnthropicCapabilitiesCache({
    successTtlMs: 1_000,
    negativeTtlMs: 100
  });

  const loader = (): Promise<AnthropicEffortCapabilities | null> =>
    new Promise((resolve) => {
      calls += 1;
      resolveLoader = resolve;
    });

  const a = cache.getOrLoad("tenant-1", loader);
  const b = cache.getOrLoad("tenant-1", loader);
  const c = cache.getOrLoad("tenant-1", loader);
  resolveLoader(makeCapabilities("x"));

  const [aResult, bResult, cResult] = await Promise.all([a, b, c]);
  expect(calls).toBe(1);
  expect(aResult?.has("x")).toBe(true);
  expect(bResult?.has("x")).toBe(true);
  expect(cResult?.has("x")).toBe(true);
});
