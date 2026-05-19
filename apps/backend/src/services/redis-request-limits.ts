import type { Redis } from "ioredis";

import type { AppConfig } from "../config.js";
import type { LimitExceededErrorPayload, RequestLimitsInterface } from "./request-limits.js";

type LimitResource = "session_create" | "message_turn";
type LimitScope = "user" | "tenant";

type RateLimitConfig = {
  windowMs: number;
  limits: Record<LimitResource, Record<LimitScope, number>>;
};

type QuotaConfig = {
  dailyTurnQuota: Record<LimitScope, number>;
};

// Atomically increment a counter and set TTL on first creation.
// Returns the new count. Uses a Lua script to avoid INCR + PEXPIRE race
// where a crash between the two commands leaves a key with no expiry.
const INCR_WITH_EXPIRY = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return current
`;

export class RedisRequestLimits implements RequestLimitsInterface {
  constructor(
    private readonly redis: Redis,
    private readonly config: {
      rateLimit: RateLimitConfig;
      quota: QuotaConfig;
    }
  ) {}

  static fromAppConfig(redis: Redis, config: Pick<
    AppConfig,
    | "RATE_LIMIT_WINDOW_MS"
    | "SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW"
    | "SESSION_CREATE_LIMIT_PER_TENANT_PER_WINDOW"
    | "MESSAGE_LIMIT_PER_USER_PER_WINDOW"
    | "MESSAGE_LIMIT_PER_TENANT_PER_WINDOW"
    | "TURN_QUOTA_PER_USER_PER_DAY"
    | "TURN_QUOTA_PER_TENANT_PER_DAY"
  >): RedisRequestLimits {
    return new RedisRequestLimits(redis, {
      rateLimit: {
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        limits: {
          session_create: {
            user: config.SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW,
            tenant: config.SESSION_CREATE_LIMIT_PER_TENANT_PER_WINDOW
          },
          message_turn: {
            user: config.MESSAGE_LIMIT_PER_USER_PER_WINDOW,
            tenant: config.MESSAGE_LIMIT_PER_TENANT_PER_WINDOW
          }
        }
      },
      quota: {
        dailyTurnQuota: {
          user: config.TURN_QUOTA_PER_USER_PER_DAY,
          tenant: config.TURN_QUOTA_PER_TENANT_PER_DAY
        }
      }
    });
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
          await this.redis.decr(k);
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
          message: `${scope === "user" ? "User" : "Tenant"} ${
            input.resource === "session_create" ? "session creation" : "message"
          } rate limit exceeded.`
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
          await this.redis.decr(k);
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
