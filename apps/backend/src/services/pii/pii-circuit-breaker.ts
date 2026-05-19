import type { Redis } from "ioredis";

export type BreakerState = "closed" | "open" | "half_open";

export type BreakerOutcome = "success" | "failure";

export interface BreakerSnapshot {
  state: BreakerState;
  // Wall-clock millis. Used by admin-status reads + tests; the breaker itself
  // doesn't need them — its logic is purely (failureCount, openedAt, now).
  failureCount: number;
  openedAt: number | null;
  willRetryAt: number | null;
}

export interface PiiCircuitBreaker {
  /**
   * Returns true when the next request is permitted to call the provider.
   * Side-effect free for callers — the breaker only changes state inside
   * `record()`.
   *
   * Note: the half-open transition is opportunistic. The first caller that
   * arrives after the cool-down expires is allowed through as the probe;
   * concurrent callers in the same window are also allowed (we don't
   * single-flight). Phase-1 simplicity over strict probe semantics.
   */
  shouldAllow(): Promise<boolean>;

  /** Record the outcome of the call permitted by the previous shouldAllow. */
  record(outcome: BreakerOutcome): Promise<void>;

  /** Read-only snapshot for diagnostics + admin UI. */
  snapshot(): Promise<BreakerSnapshot>;
}

export interface BreakerLogger {
  info(meta: object, msg: string): void;
  warn(meta: object, msg: string): void;
}

/**
 * Sink for breaker state-change events. Decoupled from PlatformEventStore so
 * tests can pass an in-memory fake without spinning up a DB. The breaker
 * never awaits the result inside the hot path — fire-and-forget with a
 * caught rejection — so a slow or failing sink can't stall provider calls.
 */
export interface BreakerEventSink {
  create(input: { type: string; payload: Record<string, unknown> }): Promise<void>;
}

interface BreakerOptions {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  now?: () => number;
  logger?: BreakerLogger;
  /** Tag for log lines; lets us tell breakers apart if we add more providers. */
  name: string;
  /** Optional sink for persistent transition history (admin dashboard timeline). */
  events?: BreakerEventSink;
}

/**
 * Per-process breaker. State is held in memory; each backend process tracks
 * its own counts. Suitable for single-instance deployments and as a fallback
 * when Redis is unavailable.
 */
export class InMemoryPiiCircuitBreaker implements PiiCircuitBreaker {
  private state: BreakerState = "closed";
  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;

  constructor(private readonly options: BreakerOptions) {}

  async shouldAllow(): Promise<boolean> {
    const now = this.now();
    if (this.state === "closed") return true;
    if (this.state === "half_open") return true;
    // open
    if (this.openedAt !== null && now - this.openedAt >= this.options.cooldownMs) {
      this.transition("half_open", now);
      return true;
    }
    return false;
  }

  async record(outcome: BreakerOutcome): Promise<void> {
    const now = this.now();
    if (outcome === "success") {
      if (this.state === "half_open") {
        this.transition("closed", now);
      }
      this.failureTimestamps = [];
      return;
    }

    if (this.state === "half_open") {
      // Probe failed — re-open with a fresh cool-down.
      this.transition("open", now);
      return;
    }

    if (this.state === "open") {
      // Already open, no need to count further. shouldAllow gated this call out.
      return;
    }

    // closed
    const cutoff = now - this.options.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
    this.failureTimestamps.push(now);
    if (this.failureTimestamps.length >= this.options.failureThreshold) {
      this.transition("open", now);
    }
  }

  async snapshot(): Promise<BreakerSnapshot> {
    return {
      state: this.state,
      failureCount: this.failureTimestamps.length,
      openedAt: this.openedAt,
      willRetryAt:
        this.state === "open" && this.openedAt !== null
          ? this.openedAt + this.options.cooldownMs
          : null
    };
  }

  private transition(next: BreakerState, now: number): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.openedAt = next === "open" ? now : null;
    if (next === "closed") {
      this.failureTimestamps = [];
    }
    this.options.logger?.info(
      { breaker: this.options.name, from: prev, to: next, at: now },
      "PII circuit breaker state change"
    );
    emitTransitionEvent(this.options, {
      provider: this.options.name,
      from: prev,
      to: next,
      failureCount: this.failureTimestamps.length,
      openedAt: this.openedAt,
      at: now
    });
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

/**
 * Redis-backed breaker. Stores state in three keys per provider so all backend
 * processes converge on the same view of provider health. The Lua script
 * lets us read+update atomically without a round-trip race.
 */
export class RedisPiiCircuitBreaker implements PiiCircuitBreaker {
  private readonly stateKey: string;
  private readonly openedAtKey: string;
  private readonly failuresKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly options: BreakerOptions & { keyPrefix?: string }
  ) {
    const prefix = options.keyPrefix ?? "pii:breaker";
    this.stateKey = `${prefix}:${options.name}:state`;
    this.openedAtKey = `${prefix}:${options.name}:openedAt`;
    this.failuresKey = `${prefix}:${options.name}:failures`;
  }

  async shouldAllow(): Promise<boolean> {
    const now = this.nowMs();
    const [state, openedAtStr] = await Promise.all([
      this.redis.get(this.stateKey),
      this.redis.get(this.openedAtKey)
    ]);
    if (state === "open") {
      const openedAt = openedAtStr ? Number(openedAtStr) : null;
      if (openedAt !== null && now - openedAt >= this.options.cooldownMs) {
        // Opportunistic transition — same semantics as in-memory. Concurrent
        // shouldAllow callers may all see "open" and then race to set
        // half_open; whichever wins, all of them get permitted. Route through
        // transitionTo so the openedAtKey is cleared, the event is emitted,
        // and the snapshot stays consistent with the live state.
        await this.transitionTo("half_open", now, "open");
        return true;
      }
      return false;
    }
    return true; // closed or half_open
  }

  async record(outcome: BreakerOutcome): Promise<void> {
    const now = this.nowMs();
    const state = (await this.redis.get(this.stateKey)) ?? "closed";

    if (outcome === "success") {
      if (state === "half_open" || state === "open") {
        await this.transitionTo("closed", now, state);
      }
      await this.redis.del(this.failuresKey);
      return;
    }

    // failure
    if (state === "half_open") {
      await this.transitionTo("open", now, state);
      return;
    }
    if (state === "open") {
      return;
    }

    const cutoff = now - this.options.windowMs;
    // ZSET of failure timestamps. Trim old entries, push the new one,
    // count the window. ZADD + ZREMRANGEBYSCORE + ZCARD pipelined keeps
    // it cheap and atomic-enough — concurrent failure floods just bounce
    // off the threshold instantly anyway.
    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(this.failuresKey, "-inf", String(cutoff));
    pipeline.zadd(this.failuresKey, String(now), `${now}-${Math.random()}`);
    pipeline.zcard(this.failuresKey);
    pipeline.pexpire(this.failuresKey, this.options.windowMs * 2);
    const results = await pipeline.exec();
    const cardEntry = results?.[2];
    const count = cardEntry && !cardEntry[0] ? Number(cardEntry[1]) : 0;
    if (count >= this.options.failureThreshold) {
      await this.transitionTo("open", now, state);
    }
  }

  async snapshot(): Promise<BreakerSnapshot> {
    const [state, openedAtStr, count] = await Promise.all([
      this.redis.get(this.stateKey),
      this.redis.get(this.openedAtKey),
      this.redis.zcard(this.failuresKey)
    ]);
    const resolvedState: BreakerState =
      state === "open" || state === "half_open" ? state : "closed";
    const openedAt = openedAtStr ? Number(openedAtStr) : null;
    return {
      state: resolvedState,
      failureCount: typeof count === "number" ? count : 0,
      openedAt,
      willRetryAt:
        resolvedState === "open" && openedAt !== null
          ? openedAt + this.options.cooldownMs
          : null
    };
  }

  private async transitionTo(
    next: BreakerState,
    now: number,
    prev: string
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.set(this.stateKey, next);
    if (next === "open") {
      pipeline.set(this.openedAtKey, String(now));
    } else {
      pipeline.del(this.openedAtKey);
    }
    if (next === "closed") {
      pipeline.del(this.failuresKey);
    }
    await pipeline.exec();
    this.options.logger?.info(
      { breaker: this.options.name, from: prev, to: next, at: now },
      "PII circuit breaker state change"
    );
    emitTransitionEvent(this.options, {
      provider: this.options.name,
      from: prev,
      to: next,
      // Best-effort failure count read; if the read fails we still emit the
      // transition with 0 (the state change itself is the load-bearing fact).
      failureCount: 0,
      openedAt: next === "open" ? now : null,
      at: now
    });
  }

  private nowMs(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

/**
 * Fire-and-forget transition emitter. Never throws, never blocks the breaker
 * hot path: a slow or unhealthy sink must not stall provider calls or compound
 * the very outage the breaker is reacting to.
 */
function emitTransitionEvent(
  options: BreakerOptions,
  payload: {
    provider: string;
    from: string;
    to: BreakerState;
    failureCount: number;
    openedAt: number | null;
    at: number;
  }
): void {
  if (!options.events) return;
  void options.events
    .create({ type: "pii_breaker_transition", payload })
    .catch((error) => {
      options.logger?.warn(
        { err: error, breaker: options.name },
        "Failed to persist PII breaker transition event"
      );
    });
}

export interface CreateBreakerInput extends BreakerOptions {
  redis: Redis | null;
}

/**
 * Pick the right backend at construction time. Redis when present (shared
 * across processes); in-memory otherwise.
 */
export function createPiiCircuitBreaker(input: CreateBreakerInput): PiiCircuitBreaker {
  if (input.redis) {
    return new RedisPiiCircuitBreaker(input.redis, input);
  }
  return new InMemoryPiiCircuitBreaker(input);
}

/**
 * No-op breaker for when PII_BREAKER_ENABLED=false. Always allows; never
 * trips. Lets the rest of the code path stay branchless.
 */
export class DisabledPiiCircuitBreaker implements PiiCircuitBreaker {
  async shouldAllow(): Promise<boolean> {
    return true;
  }
  async record(): Promise<void> {
    /* no-op */
  }
  async snapshot(): Promise<BreakerSnapshot> {
    return { state: "closed", failureCount: 0, openedAt: null, willRetryAt: null };
  }
}
