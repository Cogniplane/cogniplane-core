import { test, expect } from "vitest";
import type { Redis } from "ioredis";
import { createTestConfig } from "../test-helpers/test-config.js";
import { RedisRequestLimits, RequestLimitsUnavailableError } from "./redis-request-limits.js";

test("Redis failures fail closed with a retryable service error for rates and quotas", async () => {
  const redis = { eval: async () => { throw new Error("Redis unavailable"); } } as unknown as Redis;
  const limits = RedisRequestLimits.fromAppConfig(redis, createTestConfig());
  await expect(limits.consumeRateLimit({ resource: "message_turn", userId: "u", tenantId: "t" }))
    .rejects.toBeInstanceOf(RequestLimitsUnavailableError);
  await expect(limits.consumeTurnQuota({ userId: "u", tenantId: "t" }))
    .rejects.toMatchObject({ statusCode: 503 });
});

// Counters and window arguments only. The scripts themselves run against a
// real Redis in redis-persistence.integration.test.ts.
function countingRedis() {
  const counts = new Map<string, number>();
  const windows = new Map<string, string>();
  const redis = {
    async eval(script: string, _keyCount: number, key: string, windowMs?: string) {
      const current = counts.get(key) ?? 0;
      if (script.includes("request-limit-incr-v1")) {
        if (windowMs) windows.set(key, windowMs);
        counts.set(key, current + 1);
      } else if (current > 0) {
        counts.set(key, current - 1);
      }
      return counts.get(key) ?? 0;
    },
    async pttl() { return 42_000; }
  } as unknown as Redis;
  return { redis, counts, windows };
}

test("Redis keeps resource_read counters per user and per tenant, with their configured limits and window", async () => {
  const { redis, counts, windows } = countingRedis();
  const limits = RedisRequestLimits.fromAppConfig(redis, createTestConfig({
    RATE_LIMIT_WINDOW_MS: 30_000,
    RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW: 1,
    RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW: 5
  }));
  const input = { resource: "resource_read" as const, userId: "u", tenantId: "t" };

  expect(await limits.consumeRateLimit(input)).toBeNull();
  expect(await limits.consumeRateLimit(input)).toMatchObject({
    resource: "resource_read", scope: "user", limit: 1, retryAfterMs: 42_000,
    message: "User resource read rate limit exceeded."
  });
  expect(Object.fromEntries(counts)).toEqual({ "rl:resource_read:user:u": 1, "rl:resource_read:tenant:t": 1 });
  expect(Object.fromEntries(windows)).toEqual({ "rl:resource_read:user:u": "30000", "rl:resource_read:tenant:t": "30000" });
});

test("Redis does not count a resource_read scope whose limit is 0", async () => {
  const { redis, counts } = countingRedis();
  const limits = RedisRequestLimits.fromAppConfig(redis, createTestConfig({
    RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW: 0,
    RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW: 2
  }));
  const input = { resource: "resource_read" as const, userId: "u", tenantId: "t" };

  expect(await limits.consumeRateLimit(input)).toBeNull();
  expect(await limits.consumeRateLimit(input)).toBeNull();
  expect(await limits.consumeRateLimit(input)).toMatchObject({ scope: "tenant", limit: 2 });
  expect([...counts.keys()]).toEqual(["rl:resource_read:tenant:t"]);
});

test("settings_write counts under its own Redis keys and limits", async () => {
  const counts = new Map<string, number>();
  const redis = {
    async eval(script: string, _keyCount: number, key: string) {
      const current = counts.get(key) ?? 0;
      const next = script.includes("request-limit-decr-v1") ? Math.max(0, current - 1) : current + 1;
      counts.set(key, next);
      return next;
    },
    async pttl() {
      return 30_000;
    }
  } as unknown as Redis;
  const limits = RedisRequestLimits.fromAppConfig(redis, createTestConfig({
    SETTINGS_WRITE_LIMIT_PER_USER_PER_WINDOW: 1,
    SETTINGS_WRITE_LIMIT_PER_TENANT_PER_WINDOW: 5
  }));
  const input = { resource: "settings_write" as const, userId: "u", tenantId: "t" };

  expect(await limits.consumeRateLimit(input)).toBeNull();
  expect(await limits.consumeRateLimit(input)).toMatchObject({
    resource: "settings_write",
    scope: "user",
    limit: 1,
    retryAfterMs: 30_000
  });
  // The refused attempt is rolled back; the tenant key was not reached.
  expect([...counts]).toEqual([
    ["rl:settings_write:user:u", 1],
    ["rl:settings_write:tenant:t", 1]
  ]);
});
