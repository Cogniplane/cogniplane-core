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
