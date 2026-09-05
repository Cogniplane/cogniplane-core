import type { Redis } from "ioredis";

import {
  buildLimitsConfig,
  rateLimitMessage,
  type LimitExceededErrorPayload,
  type LimitResource,
  type RequestLimitsConfigKeys,
  type RequestLimitsInterface
} from "./request-limits.js";

type LimitScope = "user" | "tenant";

type RateLimitConfig = {
  windowMs: number;
  limits: Record<LimitResource, Record<LimitScope, number>>;
};

type QuotaConfig = {
  dailyTurnQuota: Record<LimitScope, number>;
};

// Atomically increment a counter and set its window TTL. Returns the new
// count. One Lua script rather than INCR + PEXPIRE so a crash between the two
// cannot leave a key with no expiry.
//
// Set the window TTL whenever the key has none, not only when the counter
// happens to be 1. A rollback can leave the key at 0 with its TTL intact; the
// next INCR then returns 1 again, and keying the PEXPIRE off that value would
// restart the window from that moment — so every rejected-and-retried burst
// would extend the subject's window indefinitely. Keying off PTTL == -1 also
// means any key that somehow lost its expiry self-heals on its next INCR.
const INCR_WITH_EXPIRY = `
  -- request-limit-incr-v1
  local current = redis.call('INCR', KEYS[1])
  if redis.call('PTTL', KEYS[1]) < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return current
`;

// Undo one speculative INCR without ever creating the key.
//
// A bare DECR is not safe here: if the window expired between this request's
// INCR and its rollback, DECR recreates the key at -1 with NO TTL. That key
// never expires and every later check reads a negative count, so the subject
// is exempt from the limit from then on. Decrementing only an existing key
// keeps the rollback from resurrecting one.
const DECR_IF_EXISTS = `
  -- request-limit-decr-v1
  if redis.call('EXISTS', KEYS[1]) == 1 then
    return redis.call('DECR', KEYS[1])
  end
  return 0
`;

export class RedisRequestLimits implements RequestLimitsInterface {
  constructor(
    private readonly redis: Redis,
    private readonly config: {
      rateLimit: RateLimitConfig;
      quota: QuotaConfig;
    }
  ) {}

  static fromAppConfig(redis: Redis, config: RequestLimitsConfigKeys): RedisRequestLimits {
    return new RedisRequestLimits(redis, buildLimitsConfig(config));
  }

  async consumeRateLimit(input: {
    resource: LimitResource;
    userId: string;
    tenantId: string;
  }): Promise<LimitExceededErrorPayload | null> {
    const scopes: Array<{ scope: LimitScope; subjectId: string }> = [
      { scope: "user", subjectId: input.userId },
      { scope: "tenant", subjectId: input.tenantId }
    ];

    // Atomically increment all scopes first, then check limits.
    // If any scope is exceeded, decrement all already-incremented scopes and return the error.
    const incremented: string[] = [];

    for (const { scope, subjectId } of scopes) {
      const limit = this.config.rateLimit.limits[input.resource][scope];
      if (limit <= 0) continue;

      const key = `rl:${input.resource}:${scope}:${subjectId}`;
      const newCount = (await this.redis.eval(
        INCR_WITH_EXPIRY, 1, key, String(this.config.rateLimit.windowMs)
      )) as number;
      incremented.push(key);

      if (newCount > limit) {
        // Rollback all incremented keys
        for (const k of incremented) {
          await this.redis.eval(DECR_IF_EXISTS, 1, k);
        }
        const ttl = await this.redis.pttl(key);
        const retryAfterMs = ttl > 0 ? ttl : 0;
        return {
          error: "limit_exceeded",
          limitType: "rate_limit",
          resource: input.resource,
          scope,
          limit,
          retryAfterMs,
          resetAt: new Date(Date.now() + retryAfterMs).toISOString(),
          message: rateLimitMessage(input.resource, scope)
        };
      }
    }

    return null;
  }

  async consumeTurnQuota(input: {
    userId: string;
    tenantId: string;
  }): Promise<LimitExceededErrorPayload | null> {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const resetAt = new Date(`${dayKey}T00:00:00.000Z`);
    resetAt.setUTCDate(resetAt.getUTCDate() + 1);
    const ttlMs = resetAt.getTime() - now.getTime();

    const scopes: Array<{ scope: LimitScope; subjectId: string }> = [
      { scope: "user", subjectId: input.userId },
      { scope: "tenant", subjectId: input.tenantId }
    ];

    const incrementedQuota: string[] = [];

    for (const { scope, subjectId } of scopes) {
      const limit = this.config.quota.dailyTurnQuota[scope];
      if (limit <= 0) continue;

      const key = `quota:${scope}:${subjectId}:${dayKey}`;
      const newCount = (await this.redis.eval(INCR_WITH_EXPIRY, 1, key, String(ttlMs))) as number;
      incrementedQuota.push(key);

      if (newCount > limit) {
        for (const k of incrementedQuota) {
          await this.redis.eval(DECR_IF_EXISTS, 1, k);
        }
        return {
          error: "limit_exceeded",
          limitType: "usage_quota",
          resource: "message_turn",
          scope,
          limit,
          retryAfterMs: Math.max(0, ttlMs),
          resetAt: resetAt.toISOString(),
          message: `${scope === "user" ? "User" : "Tenant"} daily turn quota exceeded.`
        };
      }
    }

    return null;
  }

  sweepExpired(): void {
    // Redis handles expiration automatically via PEXPIRE — no manual sweep needed
  }
}
