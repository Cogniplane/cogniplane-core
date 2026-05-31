import type { AppConfig } from "../config.js";

export type LimitResource =
  | "session_create"
  | "message_turn"
  | "artifact_upload"
  | "artifact_create"
  | "scheduled_job_create"
  | "oauth_callback";
type LimitScope = "user" | "tenant";
type LimitType = "rate_limit" | "usage_quota";

// Human label for a resource, used in the `message` of a limit-exceeded payload.
// Centralized so both the in-memory and Redis implementations stay in sync as
// new resources are added.
const RESOURCE_LABELS: Record<LimitResource, string> = {
  session_create: "session creation",
  message_turn: "message",
  artifact_upload: "artifact upload",
  artifact_create: "artifact creation",
  scheduled_job_create: "scheduled job creation",
  oauth_callback: "OAuth callback"
};

export function rateLimitMessage(resource: LimitResource, scope: LimitScope): string {
  return `${scope === "user" ? "User" : "Tenant"} ${RESOURCE_LABELS[resource]} rate limit exceeded.`;
}

// Config keys the rate-limit knobs are read from — shared by both fromAppConfig
// implementations so the two stay structurally identical.
export type RequestLimitsConfigKeys = Pick<
  AppConfig,
  | "RATE_LIMIT_WINDOW_MS"
  | "SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW"
  | "SESSION_CREATE_LIMIT_PER_TENANT_PER_WINDOW"
  | "MESSAGE_LIMIT_PER_USER_PER_WINDOW"
  | "MESSAGE_LIMIT_PER_TENANT_PER_WINDOW"
  | "ARTIFACT_UPLOAD_LIMIT_PER_USER_PER_WINDOW"
  | "ARTIFACT_UPLOAD_LIMIT_PER_TENANT_PER_WINDOW"
  | "ARTIFACT_CREATE_LIMIT_PER_USER_PER_WINDOW"
  | "ARTIFACT_CREATE_LIMIT_PER_TENANT_PER_WINDOW"
  | "SCHEDULED_JOB_CREATE_LIMIT_PER_USER_PER_WINDOW"
  | "SCHEDULED_JOB_CREATE_LIMIT_PER_TENANT_PER_WINDOW"
  | "OAUTH_CALLBACK_LIMIT_PER_USER_PER_WINDOW"
  | "OAUTH_CALLBACK_LIMIT_PER_TENANT_PER_WINDOW"
  | "TURN_QUOTA_PER_USER_PER_DAY"
  | "TURN_QUOTA_PER_TENANT_PER_DAY"
>;

// Build the shared rate-limit + quota config from app config. Used by both the
// in-memory and Redis stores so a new resource is added in exactly one place.
export function buildLimitsConfig(config: RequestLimitsConfigKeys): {
  rateLimit: { windowMs: number; limits: Record<LimitResource, Record<LimitScope, number>> };
  quota: { dailyTurnQuota: Record<LimitScope, number> };
} {
  return {
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
        },
        artifact_upload: {
          user: config.ARTIFACT_UPLOAD_LIMIT_PER_USER_PER_WINDOW,
          tenant: config.ARTIFACT_UPLOAD_LIMIT_PER_TENANT_PER_WINDOW
        },
        artifact_create: {
          user: config.ARTIFACT_CREATE_LIMIT_PER_USER_PER_WINDOW,
          tenant: config.ARTIFACT_CREATE_LIMIT_PER_TENANT_PER_WINDOW
        },
        scheduled_job_create: {
          user: config.SCHEDULED_JOB_CREATE_LIMIT_PER_USER_PER_WINDOW,
          tenant: config.SCHEDULED_JOB_CREATE_LIMIT_PER_TENANT_PER_WINDOW
        },
        oauth_callback: {
          user: config.OAUTH_CALLBACK_LIMIT_PER_USER_PER_WINDOW,
          tenant: config.OAUTH_CALLBACK_LIMIT_PER_TENANT_PER_WINDOW
        }
      }
    },
    quota: {
      dailyTurnQuota: {
        user: config.TURN_QUOTA_PER_USER_PER_DAY,
        tenant: config.TURN_QUOTA_PER_TENANT_PER_DAY
      }
    }
  };
}

type RateLimitConfig = {
  windowMs: number;
  limits: Record<LimitResource, Record<LimitScope, number>>;
};

type QuotaConfig = {
  dailyTurnQuota: Record<LimitScope, number>;
};

type RateWindowState = {
  count: number;
  resetAtMs: number;
};

type QuotaState = {
  dayKey: string;
  count: number;
};

export type LimitExceededErrorPayload = {
  error: "limit_exceeded";
  limitType: LimitType;
  resource: LimitResource;
  scope: LimitScope;
  limit: number;
  retryAfterMs: number;
  resetAt: string;
  message: string;
};

export interface RequestLimitsInterface {
  consumeRateLimit(input: {
    resource: LimitResource;
    userId: string;
    tenantId: string;
  }): Promise<LimitExceededErrorPayload | null>;

  consumeTurnQuota(input: {
    userId: string;
    tenantId: string;
  }): Promise<LimitExceededErrorPayload | null>;

  sweepExpired(): void;
}

/**
 * Known limitation: rate limit and quota state is stored in-memory.
 * State is lost on process restart and cannot be shared across multiple
 * backend instances. For production multi-instance deployments, migrate
 * this state to Redis or PostgreSQL.
 */
export class RequestLimits implements RequestLimitsInterface {
  private readonly rateWindows = new Map<string, RateWindowState>();
  private readonly quotaWindows = new Map<string, QuotaState>();
  private lastSweepMs = 0;

  /** Minimum interval between eviction sweeps (in milliseconds). */
  private static readonly SWEEP_INTERVAL_MS = 60_000;

  constructor(
    private readonly config: {
      rateLimit: RateLimitConfig;
      quota: QuotaConfig;
    }
  ) {}

  static fromAppConfig(config: RequestLimitsConfigKeys): RequestLimits {
    return new RequestLimits(buildLimitsConfig(config));
  }

  consumeRateLimit(input: {
    resource: LimitResource;
    userId: string;
    tenantId: string;
    now?: number;
  }): Promise<LimitExceededErrorPayload | null> {
    const now = input.now ?? Date.now();
    this.maybeSweep(now);
    const scopes: Array<{ scope: LimitScope; subjectId: string }> = [
      { scope: "user", subjectId: input.userId },
      { scope: "tenant", subjectId: input.tenantId }
    ];

    // Increment all scopes first, then check. Roll back already-incremented
    // scopes if any limit is exceeded — matches the Redis implementation's semantics.
    const incremented: Array<{ key: string; entry: RateWindowState }> = [];

    for (const { scope, subjectId } of scopes) {
      const limit = this.config.rateLimit.limits[input.resource][scope];
      if (limit <= 0) {
        continue;
      }

      const entry = this.readRateWindow(input.resource, scope, subjectId, now);
      const key = this.rateKey(input.resource, scope, subjectId);
      const next = { count: entry.count + 1, resetAtMs: entry.resetAtMs };
      this.rateWindows.set(key, next);
      incremented.push({ key, entry });

      if (next.count > limit) {
        // Roll back all incremented keys.
        for (const { key: k, entry: prev } of incremented) {
          this.rateWindows.set(k, prev);
        }
        return Promise.resolve({
          error: "limit_exceeded",
          limitType: "rate_limit",
          resource: input.resource,
          scope,
          limit,
          retryAfterMs: Math.max(0, entry.resetAtMs - now),
          resetAt: new Date(entry.resetAtMs).toISOString(),
          message: rateLimitMessage(input.resource, scope)
        });
      }
    }

    return Promise.resolve(null);
  }

  consumeTurnQuota(input: {
    userId: string;
    tenantId: string;
    now?: Date;
  }): Promise<LimitExceededErrorPayload | null> {
    const now = input.now ?? new Date();
    this.maybeSweep(now.getTime());
    const dayKey = now.toISOString().slice(0, 10);
    const resetAt = new Date(`${dayKey}T00:00:00.000Z`);
    resetAt.setUTCDate(resetAt.getUTCDate() + 1);
    const scopes: Array<{ scope: LimitScope; subjectId: string }> = [
      { scope: "user", subjectId: input.userId },
      { scope: "tenant", subjectId: input.tenantId }
    ];

    // Increment all scopes first, then check. Roll back already-incremented
    // scopes if any quota is exceeded — matches the Redis implementation's semantics.
    const incremented: Array<{ key: string; entry: QuotaState }> = [];

    for (const { scope, subjectId } of scopes) {
      const limit = this.config.quota.dailyTurnQuota[scope];
      if (limit <= 0) {
        continue;
      }

      const entry = this.readQuotaWindow(scope, subjectId, dayKey);
      const key = this.quotaKey(scope, subjectId);
      const next = { dayKey, count: entry.count + 1 };
      this.quotaWindows.set(key, next);
      incremented.push({ key, entry });

      if (next.count > limit) {
        // Roll back all incremented keys.
        for (const { key: k, entry: prev } of incremented) {
          this.quotaWindows.set(k, prev);
        }
        return Promise.resolve({
          error: "limit_exceeded",
          limitType: "usage_quota",
          resource: "message_turn",
          scope,
          limit,
          retryAfterMs: Math.max(0, resetAt.getTime() - now.getTime()),
          resetAt: resetAt.toISOString(),
          message: `${scope === "user" ? "User" : "Tenant"} daily turn quota exceeded.`
        });
      }
    }

    return Promise.resolve(null);
  }

  private readRateWindow(
    resource: LimitResource,
    scope: LimitScope,
    subjectId: string,
    now: number
  ): RateWindowState {
    const key = this.rateKey(resource, scope, subjectId);
    const current = this.rateWindows.get(key);
    if (!current || current.resetAtMs <= now) {
      const next: RateWindowState = {
        count: 0,
        resetAtMs: now + this.config.rateLimit.windowMs
      };
      this.rateWindows.set(key, next);
      return next;
    }

    return current;
  }

  private readQuotaWindow(scope: LimitScope, subjectId: string, dayKey: string): QuotaState {
    const key = this.quotaKey(scope, subjectId);
    const current = this.quotaWindows.get(key);
    if (!current || current.dayKey !== dayKey) {
      const next: QuotaState = {
        dayKey,
        count: 0
      };
      this.quotaWindows.set(key, next);
      return next;
    }

    return current;
  }

  private rateKey(resource: LimitResource, scope: LimitScope, subjectId: string): string {
    return `${resource}:${scope}:${subjectId}`;
  }

  private quotaKey(scope: LimitScope, subjectId: string): string {
    return `${scope}:${subjectId}`;
  }

  /**
   * Remove expired rate-window and stale quota entries to prevent unbounded
   * memory growth from users who stop making requests.
   */
  sweepExpired(now?: number): void {
    const nowMs = now ?? Date.now();
    const todayKey = new Date(nowMs).toISOString().slice(0, 10);

    for (const [key, state] of this.rateWindows) {
      if (state.resetAtMs <= nowMs) {
        this.rateWindows.delete(key);
      }
    }

    for (const [key, state] of this.quotaWindows) {
      if (state.dayKey !== todayKey) {
        this.quotaWindows.delete(key);
      }
    }
  }

  /**
   * Run sweepExpired at most once per SWEEP_INTERVAL_MS to amortize the cost.
   */
  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs >= RequestLimits.SWEEP_INTERVAL_MS) {
      this.lastSweepMs = nowMs;
      this.sweepExpired(nowMs);
    }
  }
}
