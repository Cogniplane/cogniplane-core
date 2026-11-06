import { createHmac } from "node:crypto";

import type { Redis } from "ioredis";

import { DERIVED_SECRET_LABELS, deriveSecret } from "../../lib/derived-secrets.js";

// Per-identifier sign-in throttle (docs/ARCHITECTURE.md, "Authentication").
//
// - Throttle, never lock: after THRESHOLD failures, each further failure sets
//   a deadline before the next try, 30 s doubling to 15 min. The record expires
//   24 h after the last failure, and a success deletes it.
// - A request before the deadline is refused at once: no hash, no database
//   read, no count, and the deadline does not move. So a flood of refused
//   requests cannot extend the wait.
// - At most MAX_IN_FLIGHT verifications per identifier run at the same time,
//   so parallel guesses cannot pass the count before it is written.
// - The key is an HMAC of the normalised email, so a known and an unknown
//   email are throttled the same way and Redis holds no address.
// - Admission and completion are two atomic steps because the Argon2 check
//   runs between them. A crash between them leaves an in-flight slot that
//   expires after IN_FLIGHT_TTL_MS.
// - Callers fail closed: a Redis error stops the sign-in with a 503.

export const THROTTLE_THRESHOLD = 5;
export const THROTTLE_BASE_DELAY_MS = 30_000;
export const THROTTLE_MAX_DELAY_MS = 15 * 60_000;
export const THROTTLE_RECORD_TTL_MS = 24 * 60 * 60_000;
export const MAX_IN_FLIGHT = 2;
export const IN_FLIGHT_TTL_MS = 30_000;

/** Separate budgets, so failures of one kind do not block the other. */
export type ThrottleKind = "password" | "second_factor";

export type ThrottleTicket = { kind: ThrottleKind; key: string };

export type ThrottleAdmission =
  | { admitted: true; ticket: ThrottleTicket }
  | { admitted: false; retryAfterMs: number };

export interface LoginThrottle {
  admit(kind: ThrottleKind, emailKey: string): Promise<ThrottleAdmission>;
  /**
   * `aborted`: the password was never checked (for example the hasher was
   * busy). It frees the in-flight slot and changes nothing else.
   */
  complete(ticket: ThrottleTicket, outcome: ThrottleOutcome): Promise<void>;
}

export type ThrottleOutcome = "success" | "failure" | "aborted";

export function throttleDelayMs(failures: number): number {
  if (failures < THROTTLE_THRESHOLD) return 0;
  return Math.min(THROTTLE_BASE_DELAY_MS * 2 ** (failures - THROTTLE_THRESHOLD), THROTTLE_MAX_DELAY_MS);
}

function identifierKey(secret: string, kind: ThrottleKind, emailKey: string): string {
  return createHmac("sha256", deriveSecret(secret, DERIVED_SECRET_LABELS.loginThrottle))
    .update(`${kind}:${emailKey}`)
    .digest("base64url");
}

// KEYS[1] record hash (fails, next), KEYS[2] in-flight counter.
// ARGV: max in flight, in-flight TTL ms. Returns {admitted, retryAfterMs}.
const ADMIT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local nextAllowed = tonumber(redis.call('HGET', KEYS[1], 'next') or '0')
if now < nextAllowed then return {0, nextAllowed - now} end
local inFlight = tonumber(redis.call('GET', KEYS[2]) or '0')
if inFlight >= tonumber(ARGV[1]) then return {0, 1000} end
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]))
return {1, 0}
`;

// ARGV: outcome, threshold, base delay ms, max delay ms, record TTL ms.
const COMPLETE_SCRIPT = `
local inFlight = tonumber(redis.call('GET', KEYS[2]) or '0')
if inFlight > 0 then redis.call('DECR', KEYS[2]) end
if ARGV[1] == 'aborted' then return 0 end
if ARGV[1] == 'success' then
  redis.call('DEL', KEYS[1])
  return 0
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local fails = redis.call('HINCRBY', KEYS[1], 'fails', 1)
local threshold = tonumber(ARGV[2])
if fails >= threshold then
  local delay = math.min(tonumber(ARGV[3]) * (2 ^ (fails - threshold)), tonumber(ARGV[4]))
  redis.call('HSET', KEYS[1], 'next', now + delay)
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
return fails
`;

export class RedisLoginThrottle implements LoginThrottle {
  constructor(
    private readonly redis: Pick<Redis, "eval">,
    private readonly secret: string
  ) {}

  private keys(ticket: ThrottleTicket): [string, string] {
    return [`login_throttle:${ticket.kind}:${ticket.key}`, `login_in_flight:${ticket.kind}:${ticket.key}`];
  }

  async admit(kind: ThrottleKind, emailKey: string): Promise<ThrottleAdmission> {
    const ticket = { kind, key: identifierKey(this.secret, kind, emailKey) };
    const result = (await this.redis.eval(
      ADMIT_SCRIPT, 2, ...this.keys(ticket), String(MAX_IN_FLIGHT), String(IN_FLIGHT_TTL_MS)
    )) as [number, number];
    return result[0] === 1 ? { admitted: true, ticket } : { admitted: false, retryAfterMs: Number(result[1]) };
  }

  async complete(ticket: ThrottleTicket, outcome: ThrottleOutcome): Promise<void> {
    await this.redis.eval(
      COMPLETE_SCRIPT, 2, ...this.keys(ticket), outcome, String(THROTTLE_THRESHOLD),
      String(THROTTLE_BASE_DELAY_MS), String(THROTTLE_MAX_DELAY_MS), String(THROTTLE_RECORD_TTL_MS)
    );
  }
}

/** Same rules in process memory, for tests. */
export class InMemoryLoginThrottle implements LoginThrottle {
  readonly records = new Map<string, { fails: number; next: number; inFlight: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private record(key: string) {
    let record = this.records.get(key);
    if (!record) {
      record = { fails: 0, next: 0, inFlight: 0 };
      this.records.set(key, record);
    }
    return record;
  }

  async admit(kind: ThrottleKind, emailKey: string): Promise<ThrottleAdmission> {
    const key = `${kind}:${emailKey}`;
    const record = this.record(key);
    const now = this.now();
    if (now < record.next) return { admitted: false, retryAfterMs: record.next - now };
    if (record.inFlight >= MAX_IN_FLIGHT) return { admitted: false, retryAfterMs: 1000 };
    record.inFlight += 1;
    return { admitted: true, ticket: { kind, key } };
  }

  async complete(ticket: ThrottleTicket, outcome: ThrottleOutcome): Promise<void> {
    const record = this.record(ticket.key);
    record.inFlight = Math.max(0, record.inFlight - 1);
    if (outcome === "aborted") return;
    if (outcome === "success") {
      this.records.delete(ticket.key);
      return;
    }
    record.fails += 1;
    const delay = throttleDelayMs(record.fails);
    if (delay > 0) record.next = this.now() + delay;
  }
}
