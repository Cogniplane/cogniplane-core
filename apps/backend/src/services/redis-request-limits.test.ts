// Tests for the Redis-backed limiter's counter arithmetic.
//
// The fake below models what these scripts actually depend on: per-key values
// AND per-key TTLs, including the difference between "no TTL" (-1) and "no
// key" (-2). A fake that ignored expiry could not distinguish a correct
// rollback from one that leaves an immortal negative counter, which is the bug
// these tests exist to pin.
//
// The scripts are Lua, so this fake is a hand-written mirror of them: it pins
// the intended semantics, not Redis's execution. Change both together.

import { test, expect } from "vitest";

import { RedisRequestLimits } from "./redis-request-limits.js";

class FakeLimitRedis {
  private readonly values = new Map<string, number>();
  /** Absolute expiry in fake-clock ms; absent means the key has no TTL. */
  private readonly expiries = new Map<string, number>();
  now = 0;

  private live(key: string): boolean {
    if (!this.values.has(key)) return false;
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && expiry <= this.now) {
      this.values.delete(key);
      this.expiries.delete(key);
      return false;
    }
    return true;
  }

  /** Mirrors Redis PTTL: -2 = no key, -1 = key with no expiry. */
  async pttl(key: string): Promise<number> {
    if (!this.live(key)) return -2;
    const expiry = this.expiries.get(key);
    return expiry === undefined ? -1 : expiry - this.now;
  }

  async eval(script: string, _numberOfKeys: number, ...args: string[]): Promise<unknown> {
    const key = args[0]!;

    if (script.includes("request-limit-incr-v1")) {
      const next = (this.live(key) ? this.values.get(key)! : 0) + 1;
      this.values.set(key, next);
      // Mirror whichever condition the script uses, so swapping it changes
      // this fake's behaviour instead of being invisible here.
      const setsTtlOnFirstCount = script.includes("current == 1");
      const needsTtl = setsTtlOnFirstCount
        ? next === 1
        : !this.expiries.has(key) || (this.expiries.get(key) ?? 0) <= this.now;
      if (needsTtl) {
        this.expiries.set(key, this.now + Number(args[1]));
      }
      return next;
    }

    if (script.includes("request-limit-decr-v1")) {
      // Read the guard out of the script rather than assuming it, so removing
      // it from the Lua actually changes what this fake does. Without that,
      // these tests would pass against the very bug they exist to catch.
      const guardsOnExists = script.includes("EXISTS");
      if (guardsOnExists && !this.live(key)) return 0;
      // A bare DECR against a missing key recreates it at -1 with no TTL —
      // Redis's real behaviour, and the failure mode under test.
      const existed = this.live(key);
      const next = (existed ? this.values.get(key)! : 0) - 1;
      this.values.set(key, next);
      if (!existed) this.expiries.delete(key);
      return next;
    }

    throw new Error(`Unsupported script: ${script}`);
  }

  /** Test-side inspection: the raw value, or undefined once expired. */
  peek(key: string): number | undefined {
    return this.live(key) ? this.values.get(key) : undefined;
  }

  /** Drop a key's expiry, leaving the value — the immortal-key state. */
  stripTtl(key: string): void {
    this.expiries.delete(key);
  }

  asRedis() {
    return this as never;
  }
}

const CONFIG = {
  rateLimit: {
    windowMs: 60_000,
    limits: {
      message_turn: { user: 2, tenant: 100 }
    } as never
  },
  quota: { dailyTurnQuota: { user: 2, tenant: 100 } }
};

function makeLimiter() {
  const redis = new FakeLimitRedis();
  return { redis, limits: new RedisRequestLimits(redis.asRedis(), CONFIG as never) };
}

test("a rejected request rolls its increment back rather than leaving it counted", async () => {
  const { redis, limits } = makeLimiter();

  expect(await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" })).toBeNull();
  expect(await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" })).toBeNull();

  const rejected = await limits.consumeRateLimit({
    resource: "message_turn",
    userId: "u1",
    tenantId: "t1"
  });
  expect(rejected?.error).toBe("limit_exceeded");

  // The over-limit attempt is not retained: the counter sits at the limit, not
  // above it, so the subject regains access exactly when the window ends.
  expect(redis.peek("rl:message_turn:user:u1")).toBe(2);
});

// The bug this closes: a bare DECR against an expired key recreates it at -1
// with NO TTL. Every later check then reads a negative count, so that subject
// is exempt from the limit for as long as the key survives — forever.
test("a rollback after the window expires never resurrects the key", async () => {
  const { redis, limits } = makeLimiter();

  await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });

  // The window lapses between this request's INCR and its rollback.
  const key = "rl:message_turn:user:u1";
  const originalEval = redis.eval.bind(redis);
  redis.eval = async (script: string, n: number, ...args: string[]) => {
    const result = await originalEval(script, n, ...args);
    if (script.includes("request-limit-incr-v1")) redis.now += 60_001;
    return result;
  };

  const rejected = await limits.consumeRateLimit({
    resource: "message_turn",
    userId: "u1",
    tenantId: "t1"
  });
  expect(rejected?.error).toBe("limit_exceeded");

  // No key at all is the correct outcome. A key at -1 here would mean
  // unlimited requests from this subject.
  expect(redis.peek(key)).toBeUndefined();
  expect(await redis.pttl(key)).toBe(-2);
});

// A rollback can leave the counter at 0 with its TTL intact. If the TTL were
// keyed off "counter == 1" instead of "no TTL", the next request would restart
// the window from that moment — so a subject who keeps getting rejected could
// hold their window open indefinitely.
test("a rejected-then-retried burst cannot hold the window open", async () => {
  const { redis, limits } = makeLimiter();
  const key = "rl:message_turn:user:u1";

  // Fill the window, then drive the counter back down to 0 through rejections.
  // Each rejection rolls back its own increment, so the counter returns to the
  // limit and — once these two expire — to 0 with the TTL still running.
  await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  const windowEndsAt = await redis.pttl(key);

  // Most of the window elapses.
  redis.now += 50_000;

  // A rejected request: increments to 3, then rolls back to 2.
  const rejected = await limits.consumeRateLimit({
    resource: "message_turn",
    userId: "u1",
    tenantId: "t1"
  });
  expect(rejected?.error).toBe("limit_exceeded");

  // The window must still end when the FIRST request set it, not be pushed out
  // by the retry. Keying the PEXPIRE off the counter value instead of the
  // missing TTL is what would extend it here.
  expect(await redis.pttl(key)).toBe(windowEndsAt - 50_000);
});

// The other half of keying off PTTL: a key that somehow lost its expiry gets
// one back on its next increment, rather than counting up forever.
test("a key with no TTL regains one on the next increment", async () => {
  const { redis, limits } = makeLimiter();
  const key = "rl:message_turn:user:u1";

  await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  redis.stripTtl(key);
  expect(await redis.pttl(key)).toBe(-1);

  await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });

  expect(await redis.pttl(key)).toBe(60_000);
});

test("the daily quota rollback is guarded the same way", async () => {
  const { redis, limits } = makeLimiter();

  await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1" });
  await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1" });

  const originalEval = redis.eval.bind(redis);
  redis.eval = async (script: string, n: number, ...args: string[]) => {
    const result = await originalEval(script, n, ...args);
    // Crossing UTC midnight expires the day-keyed counter.
    if (script.includes("request-limit-incr-v1")) redis.now += 24 * 60 * 60 * 1000;
    return result;
  };

  const rejected = await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1" });
  expect(rejected?.error).toBe("limit_exceeded");

  const dayKey = new Date().toISOString().slice(0, 10);
  expect(redis.peek(`quota:user:u1:${dayKey}`)).toBeUndefined();
});
