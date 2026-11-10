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
