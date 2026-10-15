import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  completeRefreshRotation, consumeRefreshJti, issueRefreshJti, restoreRefreshJti,
  revokeRefreshFamily, waitForRefreshRotation, REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS
} from "../lib/refresh-token-store.js";
import { RedisRequestLimits } from "../services/redis-request-limits.js";
import { createTestConfig } from "../test-helpers/test-config.js";

if (process.env.INTEGRATION_REQUIRE_REDIS === "1" && !process.env.INTEGRATION_REDIS_URL) {
  throw new Error("INTEGRATION_REQUIRE_REDIS=1 but INTEGRATION_REDIS_URL is not set.");
}

function setup() {
  const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
  const id = randomUUID();
  onTestFinished(async () => {
    try {
      const keys = await redis.keys(`*${id}*`);
      if (keys.length) await redis.del(...keys);
    } finally { await redis.quit(); }
  });
  return { redis, jti: `${id}-token`, familyId: `${id}-family`, userId: `${id}-user`, tenantId: `${id}-tenant` };
}

async function redisTimeMs(redis: Redis): Promise<number> {
  const [seconds, microseconds] = await redis.time();
  return Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
}

async function expiry(redis: Redis, key: string): Promise<number> {
  return Number(await redis.call("PEXPIRETIME", key));
}

describe.skipIf(!process.env.INTEGRATION_REDIS_URL)("refresh rotation in Redis", () => {
  test("issues bounded tokens and preserves the family's original login deadline", async () => {
    const h = setup();
    await issueRefreshJti(h.redis, { ...h, ttlSeconds: 60, loginAtEpochSeconds: 100 });
    expect(await h.redis.get(`refresh_jti:${h.jti}`)).toBe(h.familyId);
    expect(await h.redis.get(`refresh_family:${h.familyId}`)).toBe("active");
    for (const key of [`refresh_jti:${h.jti}`, `refresh_family:${h.familyId}`]) {
      expect(await h.redis.pttl(key)).toBeGreaterThan(0);
      expect(await h.redis.pttl(key)).toBeLessThanOrEqual(60_000);
    }
    const loginKey = `refresh_family_login_at:${h.familyId}`;
    const deadline = await expiry(h.redis, loginKey);
    await issueRefreshJti(h.redis, { ...h, jti: `${h.jti}-next`, ttlSeconds: 60, loginAtEpochSeconds: 200 });
    expect(await h.redis.get(loginKey)).toBe("100");
    expect(await expiry(h.redis, loginKey)).toBe(deadline);
  });

  test("concurrent claims have one winner and share its completed result", async () => {
    const h = setup();
    await issueRefreshJti(h.redis, { ...h, ttlSeconds: 60 });
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeRefreshJti(h.redis, h)));
    expect(results.filter(result => result.status === "ok")).toEqual([{ status: "ok", familyId: h.familyId }]);
    expect(results.filter(result => result.status === "concurrent")).toHaveLength(7);
    expect(await h.redis.get(`refresh_jti:${h.jti}`)).toBeNull();
    const result = { accessToken: "access", refreshToken: "refresh" };
    await completeRefreshRotation(h.redis, { jti: h.jti, result });
    expect(await consumeRefreshJti(h.redis, h)).toEqual({ status: "concurrent", result });
    expect(await waitForRefreshRotation(h.redis, { jti: h.jti })).toEqual(result);
    expect(await restoreRefreshJti(h.redis, h)).toBe(false);
    expect(await h.redis.get(`refresh_jti:${h.jti}`)).toBeNull();
    expect(await waitForRefreshRotation(h.redis, { jti: h.jti })).toEqual(result);
  });

  test("restores a failed claim with the exact remaining family deadline", async () => {
    const h = setup();
    await issueRefreshJti(h.redis, { ...h, ttlSeconds: 60 });
    await h.redis.pexpire(`refresh_family:${h.familyId}`, 20_000);
    const deadline = await expiry(h.redis, `refresh_family:${h.familyId}`);
    expect(await consumeRefreshJti(h.redis, h)).toMatchObject({ status: "ok" });
    expect(await restoreRefreshJti(h.redis, h)).toBe(true);
    expect(await expiry(h.redis, `refresh_jti:${h.jti}`)).toBe(deadline);
    expect(await h.redis.get(`refresh_rotation:${h.jti}`)).toBeNull();
    expect(await consumeRefreshJti(h.redis, h)).toMatchObject({ status: "ok" });
  });

  test("revocation blocks restoration, further issue, and consumption", async () => {
    const h = setup();
    await issueRefreshJti(h.redis, { ...h, ttlSeconds: 60 });
    await consumeRefreshJti(h.redis, h);
    await revokeRefreshFamily(h.redis, { ...h, ttlSeconds: 60 });
    expect(await restoreRefreshJti(h.redis, h)).toBe(false);
    expect(await h.redis.get(`refresh_jti:${h.jti}`)).toBeNull();
    await expect(issueRefreshJti(h.redis, { ...h, jti: `${h.jti}-next`, ttlSeconds: 60 })).rejects.toThrow("revoked family");
    expect(await h.redis.get(`refresh_jti:${h.jti}-next`)).toBeNull();
    expect(await consumeRefreshJti(h.redis, h)).toEqual({ status: "revoked" });
    expect(await h.redis.pttl(`refresh_family:${h.familyId}`)).toBeGreaterThan(0);
  });

  test("expired rotation grace detects replay while unknown credentials remain not found", async () => {
    const h = setup();
    expect(await consumeRefreshJti(h.redis, h)).toEqual({ status: "not_found" });
    await issueRefreshJti(h.redis, { ...h, ttlSeconds: 60 });
    await consumeRefreshJti(h.redis, h);
    await h.redis.pexpire(`refresh_rotation:${h.jti}`, 0);
    expect(await consumeRefreshJti(h.redis, h)).toEqual({ status: "reuse_detected", familyId: h.familyId });
  });

  test("absolute lifetime permits the last second and revokes at the boundary", async () => {
    const h = setup();
    const loginAtEpochSeconds = 1_000;
    await issueRefreshJti(h.redis, { ...h, ttlSeconds: 60, loginAtEpochSeconds });
    const deadline = loginAtEpochSeconds + REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS;
    expect(await consumeRefreshJti(h.redis, { ...h, nowEpochSeconds: deadline - 1 })).toMatchObject({ status: "ok" });
    expect(await restoreRefreshJti(h.redis, h)).toBe(true);
    expect(await consumeRefreshJti(h.redis, { ...h, nowEpochSeconds: deadline })).toEqual({ status: "absolute_expired" });
    expect(await h.redis.get(`refresh_family:${h.familyId}`)).toBe("revoked");
    expect(await restoreRefreshJti(h.redis, h)).toBe(false);
  });

  test("a mismatched claim identifies the token's actual family", async () => {
    const h = setup();
    await issueRefreshJti(h.redis, { ...h, ttlSeconds: 60 });
    await issueRefreshJti(h.redis, { jti: `${h.jti}-other`, familyId: `${h.familyId}-other`, ttlSeconds: 60 });
    expect(await consumeRefreshJti(h.redis, { jti: h.jti, familyId: `${h.familyId}-other` }))
      .toEqual({ status: "reuse_detected", familyId: h.familyId });
  });
});

describe.skipIf(!process.env.INTEGRATION_REDIS_URL)("request limits in Redis", () => {
  function limiter() {
    const h = setup();
    const limits = RedisRequestLimits.fromAppConfig(h.redis, createTestConfig({
      RATE_LIMIT_WINDOW_MS: 60_000, MESSAGE_LIMIT_PER_USER_PER_WINDOW: 10,
      MESSAGE_LIMIT_PER_TENANT_PER_WINDOW: 1, TURN_QUOTA_PER_USER_PER_DAY: 10,
      TURN_QUOTA_PER_TENANT_PER_DAY: 1
    }));
    return { ...h, limits, input: { resource: "message_turn" as const, userId: h.userId, tenantId: h.tenantId } };
  }

  test("tenant refusals refund every speculative rate and quota charge", async () => {
    const h = limiter();
    expect(await h.limits.consumeRateLimit(h.input)).toBeNull();
    expect(await h.limits.consumeTurnQuota(h.input)).toBeNull();
    for (let attempt = 0; attempt < 12; attempt++) {
      expect(await h.limits.consumeRateLimit(h.input)).toMatchObject({ scope: "tenant", limit: 1 });
      expect(await h.limits.consumeTurnQuota(h.input)).toMatchObject({ scope: "tenant", limit: 1 });
    }
    expect(await h.redis.get(`rl:message_turn:user:${h.userId}`)).toBe("1");
    expect(await h.redis.get(`rl:message_turn:tenant:${h.tenantId}`)).toBe("1");
    const quotaKeys = await h.redis.keys(`quota:*:${h.userId}:*`);
    expect(quotaKeys).toHaveLength(1);
    expect(await h.redis.get(quotaKeys[0]!)).toBe("1");
    expect(await h.redis.pttl(quotaKeys[0]!)).toBeGreaterThan(0);
  });

  test("refunds stop at zero, preserve expiry on reuse, and do not resurrect expired keys", async () => {
    const h = limiter();
    await h.limits.consumeRateLimit(h.input);
    const key = `rl:message_turn:user:${h.userId}`;
    await h.redis.pexpire(key, 20_000);
    const deadline = await expiry(h.redis, key);
    await h.limits.refundRateLimit(h.input);
    await h.limits.refundRateLimit(h.input);
    expect(await h.redis.get(key)).toBe("0");
    expect(await h.limits.consumeRateLimit(h.input)).toBeNull();
    expect(await expiry(h.redis, key)).toBe(deadline);
    await h.redis.pexpire(key, 0);
    await h.limits.refundRateLimit(h.input);
    expect(await h.redis.get(key)).toBeNull();
    expect(await h.redis.pttl(key)).toBe(-2);
  });

  test("an existing counter without a deadline receives the configured window", async () => {
    const h = limiter();
    const key = `rl:message_turn:user:${h.userId}`;
    await h.redis.set(key, "0");
    expect(await h.redis.pttl(key)).toBe(-1);
    const before = await redisTimeMs(h.redis);
    expect(await h.limits.consumeRateLimit(h.input)).toBeNull();
    const after = await redisTimeMs(h.redis);
    const deadline = await expiry(h.redis, key);
    expect(deadline).toBeGreaterThanOrEqual(before + 60_000);
    expect(deadline).toBeLessThanOrEqual(after + 60_000);
  });
});
