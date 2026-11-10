import { test, expect } from "vitest";
import type { Redis } from "ioredis";
import { createTestConfig } from "../test-helpers/test-config.js";
import { FakeLimitRedis } from "../test-helpers/fake-limit-redis.js";
import { RedisRequestLimits, RequestLimitsUnavailableError } from "./redis-request-limits.js";

test("Redis failures fail closed with a retryable service error for rates and quotas", async () => {
  const redis = { eval: async () => { throw new Error("Redis unavailable"); } } as unknown as Redis;
  const limits = RedisRequestLimits.fromAppConfig(redis, createTestConfig());
  await expect(limits.consumeRateLimit({ resource: "message_turn", userId: "u", tenantId: "t" }))
    .rejects.toBeInstanceOf(RequestLimitsUnavailableError);
  await expect(limits.consumeTurnQuota({ userId: "u", tenantId: "t" }))
    .rejects.toMatchObject({ statusCode: 503 });
});

// Issue #47: the shared limiter writes one key per auth subject, under the
// configured window, and never a tenant key for the auth limits.
test("auth limits write one key per subject in the configured window", async () => {
  const redis = new FakeLimitRedis();
  const limits = RedisRequestLimits.fromAppConfig(redis.asRedis(), createTestConfig({
    RATE_LIMIT_WINDOW_MS: 30_000,
    AUTH_SIGN_IN_LIMIT_PER_IP_PER_WINDOW: 1,
    AUTH_REFRESH_LIMIT_PER_FAMILY_PER_WINDOW: 2
  }));
  const family = { resource: "auth_refresh" as const, userId: "family:fid-1", tenantId: "family:fid-1" };
  const anonymous = { resource: "auth_refresh" as const, userId: "ip:2001:db8::1", tenantId: "ip:2001:db8::1" };
  const signIn = { resource: "auth_sign_in" as const, userId: "2001:db8::1", tenantId: "2001:db8::1" };

  expect(await limits.consumeRateLimit(family)).toBeNull();
  expect(await limits.consumeRateLimit(family)).toBeNull();
  const refused = await limits.consumeRateLimit(family);
  expect(await limits.consumeRateLimit(anonymous)).toBeNull();
  expect(await limits.consumeRateLimit(signIn)).toBeNull();
  expect(await limits.consumeRateLimit(signIn)).toMatchObject({ resource: "auth_sign_in", limit: 1 });

  expect(refused).toMatchObject({ resource: "auth_refresh", scope: "user", limit: 2 });
  expect(refused!.retryAfterMs).toBeGreaterThan(29_000);
  expect([...redis.counters.entries()].map(([key, entry]) => [key, entry.count])).toEqual([
    ["rl:auth_refresh:user:family:fid-1", 2],
    ["rl:auth_refresh:user:ip:2001:db8::1", 1],
    ["rl:auth_sign_in:user:2001:db8::1", 1]
  ]);
  for (const key of redis.counters.keys()) expect(redis.windowOf(key)).toBeLessThanOrEqual(30_000);
});
