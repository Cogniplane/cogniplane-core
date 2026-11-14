import { randomUUID } from "node:crypto";

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

/**
 * Permission for one provider call, from `admit`. Pass it to `record` with
 * the outcome, or to `release` when the call ends without one (the caller
 * aborted). The breaker then applies the outcome only to the state that
 * admitted the call:
 *
 * - `generation` changes at each transition. An outcome of an older
 *   generation changes nothing, so a slow success that started before an
 *   outage cannot close the breaker during it.
 * - `probe` is set for the one call that tests the provider in `half_open`.
 *   Only that call can close or reopen the breaker.
 */
export type BreakerPermit = {
  readonly generation: string;
  readonly probe: string | null;
};

export type BreakerAdmission = { allowed: true; permit: BreakerPermit } | { allowed: false };

export interface PiiCircuitBreaker {
  /**
   * `closed` admits every call. `open` refuses calls until the cool-down
   * ends; the first call after it moves the breaker to `half_open` and gets
   * the probe. `half_open` admits only the probe. A probe that gives no
   * outcome in `probeTtlMs` (its process stopped) expires, and the next call
   * becomes the probe.
   */
  admit(): Promise<BreakerAdmission>;

  /** Record the outcome of an admitted call. Stale permits change nothing. */
  record(permit: BreakerPermit, outcome: BreakerOutcome): Promise<void>;

  /** The admitted call ended without an outcome. A probe permit frees the probe. */
  release(permit: BreakerPermit): Promise<void>;

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
  /**
   * How long a half-open probe holds its permit. Set it above the longest
   * provider call. Default: 60 seconds.
   */
  probeTtlMs?: number;
  now?: () => number;
  logger?: BreakerLogger;
  /** Tag for log lines; lets us tell breakers apart if we add more providers. */
  name: string;
  /** Optional sink for persistent transition history (admin dashboard timeline). */
  events?: BreakerEventSink;
}

const DEFAULT_PROBE_TTL_MS = 60_000;

/** A permit that the breaker does not track (Redis down, breaker off). */
const UNTRACKED_PERMIT: BreakerPermit = Object.freeze({ generation: "", probe: null });

/**
 * Per-process breaker. State is held in memory; each backend process tracks
 * its own counts. Suitable for single-instance deployments and as a fallback
 * when Redis is unavailable.
 */
export class InMemoryPiiCircuitBreaker implements PiiCircuitBreaker {
  private state: BreakerState = "closed";
  private generation = 0;
  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;
  private probe: { token: string; until: number } | null = null;
  private nextProbe = 0;

  constructor(private readonly options: BreakerOptions) {}

  async admit(): Promise<BreakerAdmission> {
    const now = this.now();
    if (this.state === "closed") return this.allow(null);
    if (this.state === "open") {
      if (this.openedAt === null || now - this.openedAt < this.options.cooldownMs) return { allowed: false };
      this.transition("half_open", now);
      return this.allow(this.takeProbe(now));
    }
    if (this.probe && this.probe.until > now) return { allowed: false };
    return this.allow(this.takeProbe(now));
  }

  async record(permit: BreakerPermit, outcome: BreakerOutcome): Promise<void> {
    if (permit.generation !== String(this.generation)) return;
    const now = this.now();
    if (this.state === "closed") {
      if (outcome === "success") {
        this.failureTimestamps = [];
        return;
      }
      const cutoff = now - this.options.windowMs;
      this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
      this.failureTimestamps.push(now);
      if (this.failureTimestamps.length >= this.options.failureThreshold) {
        this.transition("open", now);
      }
      return;
    }
    if (this.state === "half_open" && permit.probe !== null && this.probe?.token === permit.probe) {
      this.probe = null;
      this.transition(outcome === "success" ? "closed" : "open", now);
    }
  }

  async release(permit: BreakerPermit): Promise<void> {
    if (permit.probe !== null && permit.generation === String(this.generation) && this.probe?.token === permit.probe) {
      this.probe = null;
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

  private allow(probe: string | null): BreakerAdmission {
    return { allowed: true, permit: { generation: String(this.generation), probe } };
  }

  private takeProbe(now: number): string {
    this.nextProbe += 1;
    const token = String(this.nextProbe);
    this.probe = { token, until: now + (this.options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS) };
    return token;
  }

  private transition(next: BreakerState, now: number): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.generation += 1;
    this.openedAt = next === "open" ? now : null;
    if (next !== "half_open") this.probe = null;
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

// One hash per breaker holds the state: `state`, `gen`, `epoch`, `openedAt`,
// and while half-open the probe (`probe`, `probeUntil`). `epoch` is random and
// set when the hash is created, so after a flush or a lost key a permit of the
// old hash cannot match a new one with the same generation.
//
// Each script reads and changes the state in one step on the Redis server.
// The scripts only change state; the caller logs and records the transition.

// KEYS[1] state hash. ARGV: now, cooldownMs, probeTtlMs, new epoch, probe token.
// Returns {allowed, epoch, gen, probe, previous state when it moved to half_open}.
const ADMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local epoch = redis.call('HGET', KEYS[1], 'epoch')
if not epoch then
  epoch = ARGV[4]
  redis.call('HSET', KEYS[1], 'epoch', epoch, 'gen', '0', 'state', 'closed')
end
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local gen = redis.call('HGET', KEYS[1], 'gen') or '0'
if state == 'closed' then
  return {1, epoch, gen, '', ''}
end
if state == 'open' then
  local openedAt = tonumber(redis.call('HGET', KEYS[1], 'openedAt') or '0')
  if now - openedAt < tonumber(ARGV[2]) then
    return {0, epoch, gen, '', ''}
  end
  gen = tostring(tonumber(gen) + 1)
  redis.call('HSET', KEYS[1], 'state', 'half_open', 'gen', gen, 'probe', ARGV[5],
    'probeUntil', tostring(now + tonumber(ARGV[3])))
  redis.call('HDEL', KEYS[1], 'openedAt')
  return {1, epoch, gen, ARGV[5], 'open'}
end
local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0')
if redis.call('HEXISTS', KEYS[1], 'probe') == 1 and probeUntil > now then
  return {0, epoch, gen, '', ''}
end
redis.call('HSET', KEYS[1], 'probe', ARGV[5], 'probeUntil', tostring(now + tonumber(ARGV[3])))
return {1, epoch, gen, ARGV[5], ''}
`;

// KEYS[1] state hash, KEYS[2] failure set. ARGV: now, epoch, gen, probe,
// outcome, windowMs, threshold, failure member.
// Returns {'stale'}, {'ok'}, or {'moved', from, to, failure count}.
const RECORD_SCRIPT = `
local now = tonumber(ARGV[1])
if redis.call('HGET', KEYS[1], 'epoch') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'gen') ~= ARGV[3] then
  return {'stale'}
end
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local nextGen = tostring(tonumber(ARGV[3]) + 1)
if state == 'closed' then
  if ARGV[5] == 'success' then
    redis.call('DEL', KEYS[2])
    return {'ok'}
  end
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. tostring(now - tonumber(ARGV[6])))
  redis.call('ZADD', KEYS[2], now, ARGV[8])
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[6]) * 2)
  local count = redis.call('ZCARD', KEYS[2])
  if count >= tonumber(ARGV[7]) then
    redis.call('HSET', KEYS[1], 'state', 'open', 'gen', nextGen, 'openedAt', tostring(now))
    return {'moved', 'closed', 'open', tostring(count)}
  end
  return {'ok'}
end
if state == 'half_open' then
  if ARGV[4] == '' or redis.call('HGET', KEYS[1], 'probe') ~= ARGV[4] then
    return {'stale'}
  end
  redis.call('HDEL', KEYS[1], 'probe', 'probeUntil')
  if ARGV[5] == 'success' then
    redis.call('HSET', KEYS[1], 'state', 'closed', 'gen', nextGen)
    redis.call('DEL', KEYS[2])
    return {'moved', 'half_open', 'closed', '0'}
  end
  redis.call('HSET', KEYS[1], 'state', 'open', 'gen', nextGen, 'openedAt', tostring(now))
  return {'moved', 'half_open', 'open', tostring(redis.call('ZCARD', KEYS[2]))}
end
return {'stale'}
`;

// KEYS[1] state hash. ARGV: epoch, gen, probe. Frees the probe it names.
const RELEASE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'epoch') == ARGV[1] and redis.call('HGET', KEYS[1], 'gen') == ARGV[2]
  and redis.call('HGET', KEYS[1], 'probe') == ARGV[3] then
  redis.call('HDEL', KEYS[1], 'probe', 'probeUntil')
  return 1
end
return 0
`;

/**
 * Redis-backed breaker, shared by all backend processes. A Lua script makes
 * each admission and each outcome one atomic step (see the scripts above).
 * Both keys of a breaker have the same hash tag (`{name}`), so they are in
 * one Redis Cluster slot.
 *
 * When Redis fails, `admit` allows the call with a permit that the breaker
 * does not track, and `record` of that permit does nothing: provider
 * scanning continues during a Redis outage, as before, without a breaker.
 */
export class RedisPiiCircuitBreaker implements PiiCircuitBreaker {
  private lastWarningAt = Number.NEGATIVE_INFINITY;
  private readonly stateKey: string;
  private readonly failuresKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly options: BreakerOptions & { keyPrefix?: string }
  ) {
    const prefix = options.keyPrefix ?? "pii:breaker";
    this.stateKey = `${prefix}:{${options.name}}:state`;
    this.failuresKey = `${prefix}:{${options.name}}:failures`;
  }

  async admit(): Promise<BreakerAdmission> {
    const now = this.nowMs();
    let reply: [number, string, string, string, string];
    try {
      reply = (await this.redis.eval(
        ADMIT_SCRIPT, 1, this.stateKey,
        String(now), String(this.options.cooldownMs),
        String(this.options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS), randomUUID(), randomUUID()
      )) as [number, string, string, string, string];
    } catch (error) {
      this.warnUnavailable(error);
      return { allowed: true, permit: UNTRACKED_PERMIT };
    }
    const [allowed, epoch, gen, probe, movedFrom] = reply;
    if (movedFrom) this.announce(movedFrom, "half_open", now, 0);
    if (Number(allowed) !== 1) return { allowed: false };
    return { allowed: true, permit: { generation: `${epoch}:${gen}`, probe: probe || null } };
  }

  async record(permit: BreakerPermit, outcome: BreakerOutcome): Promise<void> {
    if (permit.generation === "") return;
    const [epoch, gen] = splitGeneration(permit.generation);
    const now = this.nowMs();
    try {
      const reply = (await this.redis.eval(
        RECORD_SCRIPT, 2, this.stateKey, this.failuresKey,
        String(now), epoch, gen, permit.probe ?? "", outcome,
        String(this.options.windowMs), String(this.options.failureThreshold), `${now}-${randomUUID()}`
      )) as string[];
      if (reply[0] === "moved") this.announce(reply[1]!, reply[2] as BreakerState, now, Number(reply[3] ?? 0));
    } catch (error) {
      this.warnUnavailable(error);
    }
  }

  async release(permit: BreakerPermit): Promise<void> {
    if (permit.generation === "" || permit.probe === null) return;
    const [epoch, gen] = splitGeneration(permit.generation);
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, this.stateKey, epoch, gen, permit.probe);
    } catch (error) {
      // The probe then expires after probeTtlMs.
      this.warnUnavailable(error);
    }
  }

  async snapshot(): Promise<BreakerSnapshot> {
    const [hash, count] = await Promise.all([
      this.redis.hgetall(this.stateKey),
      this.redis.zcard(this.failuresKey)
    ]);
    const state = hash.state;
    const resolvedState: BreakerState =
      state === "open" || state === "half_open" ? state : "closed";
    const openedAt = resolvedState === "open" && hash.openedAt ? Number(hash.openedAt) : null;
    return {
      state: resolvedState,
      failureCount: typeof count === "number" ? count : 0,
      openedAt,
      willRetryAt: openedAt !== null ? openedAt + this.options.cooldownMs : null
    };
  }

  private announce(prev: string, next: BreakerState, now: number, failureCount: number): void {
    this.options.logger?.info(
      { breaker: this.options.name, from: prev, to: next, at: now },
      "PII circuit breaker state change"
    );
    emitTransitionEvent(this.options, {
      provider: this.options.name,
      from: prev,
      to: next,
      failureCount,
      openedAt: next === "open" ? now : null,
      at: now
    });
  }

  private nowMs(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private warnUnavailable(error: unknown): void {
    const now = this.nowMs();
    if (now - this.lastWarningAt < 60_000) return;
    this.lastWarningAt = now;
    this.options.logger?.warn(
      { err: error, breaker: this.options.name },
      "PII breaker store unavailable; provider scanning continues"
    );
  }
}

function splitGeneration(generation: string): [string, string] {
  const index = generation.lastIndexOf(":");
  return [generation.slice(0, index), generation.slice(index + 1)];
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
  async admit(): Promise<BreakerAdmission> {
    return { allowed: true, permit: UNTRACKED_PERMIT };
  }
  async record(_permit: BreakerPermit, _outcome: BreakerOutcome): Promise<void> {
    /* no-op */
  }
  async release(_permit: BreakerPermit): Promise<void> {
    /* no-op */
  }
  async snapshot(): Promise<BreakerSnapshot> {
    return { state: "closed", failureCount: 0, openedAt: null, willRetryAt: null };
  }
}
