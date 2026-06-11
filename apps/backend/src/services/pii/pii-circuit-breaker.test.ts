import { test, expect } from "vitest";

import type { Redis } from "ioredis";

import {
  DisabledPiiCircuitBreaker,
  InMemoryPiiCircuitBreaker,
  RedisPiiCircuitBreaker
} from "./pii-circuit-breaker.js";

/**
 * Hand-rolled in-memory Redis stand-in. Implements the subset the
 * RedisPiiCircuitBreaker uses: get/set/del + pipelined zremrangebyscore /
 * zadd / zcard / pexpire / set / del. The ZSET is just an in-memory
 * Map<string, number> that we count against numeric score boundaries.
 */
function makeFakeRedis(): {
  redis: Redis;
  store: Map<string, string>;
  zsets: Map<string, Map<string, number>>;
} {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();

  function zsetFor(key: string): Map<string, number> {
    let z = zsets.get(key);
    if (!z) {
      z = new Map();
      zsets.set(key, z);
    }
    return z;
  }

  const pipeline = () => {
    const ops: Array<() => unknown> = [];
    const api = {
      set(key: string, value: string) {
        ops.push(() => store.set(key, value));
        return api;
      },
      del(key: string) {
        ops.push(() => {
          store.delete(key);
          zsets.delete(key);
        });
        return api;
      },
      zremrangebyscore(key: string, min: string, max: string) {
        ops.push(() => {
          const minN = min === "-inf" ? -Infinity : Number(min);
          const maxN = max === "+inf" ? Infinity : Number(max);
          const z = zsetFor(key);
          for (const [m, s] of [...z]) {
            if (s >= minN && s <= maxN) z.delete(m);
          }
        });
        return api;
      },
      zadd(key: string, score: string, member: string) {
        ops.push(() => zsetFor(key).set(member, Number(score)));
        return api;
      },
      zcard(key: string) {
        ops.push(() => zsetFor(key).size);
        return api;
      },
      pexpire(_key: string, _ms: number) {
        ops.push(() => 1);
        return api;
      },
      async exec() {
        const results: Array<[Error | null, unknown]> = [];
        for (const op of ops) {
          try {
            results.push([null, op()]);
          } catch (e) {
            results.push([e as Error, null]);
          }
        }
        return results;
      }
    };
    return api;
  };

  const redis = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return "OK";
    },
    async del(key: string) {
      const had = store.has(key) || zsets.has(key);
      store.delete(key);
      zsets.delete(key);
      return had ? 1 : 0;
    },
    async zcard(key: string) {
      return zsetFor(key).size;
    },
    pipeline
  };
  return { redis: redis as unknown as Redis, store, zsets };
}

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    }
  };
}

test("InMemory: starts closed and stays closed under threshold", async () => {
  const clock = makeClock();
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 5,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: clock.now
  });

  for (let i = 0; i < 4; i += 1) {
    expect(await breaker.shouldAllow()).toBe(true);
    await breaker.record("failure");
  }
  expect((await breaker.snapshot()).state).toBe("closed");
});

test("InMemory: trips open at threshold and rejects subsequent calls", async () => {
  const clock = makeClock();
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 3,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: clock.now
  });

  for (let i = 0; i < 3; i += 1) {
    await breaker.record("failure");
  }
  expect((await breaker.snapshot()).state).toBe("open");
  expect(await breaker.shouldAllow()).toBe(false);
});

test("InMemory: failures outside the window do not count", async () => {
  const clock = makeClock();
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 3,
    windowMs: 1_000,
    cooldownMs: 30_000,
    now: clock.now
  });

  await breaker.record("failure");
  await breaker.record("failure");
  clock.advance(2_000); // outside the 1s window
  await breaker.record("failure");
  // Window slid forward, only the last failure remains: still closed.
  expect((await breaker.snapshot()).state).toBe("closed");
});

test("InMemory: a single success in closed state resets the failure count", async () => {
  const clock = makeClock();
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 3,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: clock.now
  });
  await breaker.record("failure");
  await breaker.record("failure");
  await breaker.record("success");
  await breaker.record("failure");
  // Two failures pre-success don't count anymore — only the post-success one.
  expect((await breaker.snapshot()).failureCount).toBe(1);
});

test("InMemory: cool-down -> half-open -> success closes", async () => {
  const clock = makeClock();
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 1_000,
    now: clock.now
  });

  await breaker.record("failure");
  await breaker.record("failure");
  expect((await breaker.snapshot()).state).toBe("open");
  expect(await breaker.shouldAllow()).toBe(false);

  clock.advance(1_000);
  // First call after cool-down transitions to half_open and is permitted.
  expect(await breaker.shouldAllow()).toBe(true);
  expect((await breaker.snapshot()).state).toBe("half_open");

  await breaker.record("success");
  expect((await breaker.snapshot()).state).toBe("closed");
});

test("InMemory: half-open probe failure re-opens with fresh cool-down", async () => {
  const clock = makeClock();
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 1_000,
    now: clock.now
  });

  await breaker.record("failure");
  await breaker.record("failure");
  clock.advance(1_000);
  await breaker.shouldAllow(); // -> half_open
  await breaker.record("failure");
  const snap = await breaker.snapshot();
  expect(snap.state).toBe("open");
  // willRetryAt should be cool-down ms after the new openedAt, not the old one.
  expect(snap.willRetryAt).toBe(snap.openedAt! + 1_000);
});

test("InMemory: snapshot exposes willRetryAt only when open", async () => {
  const clock = makeClock();
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: clock.now
  });

  expect((await breaker.snapshot()).willRetryAt).toBe(null);
  await breaker.record("failure");
  await breaker.record("failure");
  const opened = await breaker.snapshot();
  expect(opened.state).toBe("open");
  expect(opened.willRetryAt).toBe(opened.openedAt! + 30_000);
});

test("InMemory: failures while open are not counted (shouldAllow gates them)", async () => {
  const clock = makeClock();
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: clock.now
  });

  await breaker.record("failure");
  await breaker.record("failure");
  const before = (await breaker.snapshot()).openedAt;
  // Records during open are no-ops — openedAt must not move.
  await breaker.record("failure");
  const after = (await breaker.snapshot()).openedAt;
  expect(after).toBe(before);
});

test("Redis: shouldAllow open→half_open routes through transitionTo (clears openedAt + emits event)", async () => {
  // Regression: an earlier version used a bare `redis.set('half_open')`
  // which left the openedAt key behind and skipped the event sink. This
  // test pins the contract by checking both observables: the openedAt key
  // is gone AND a transition event was emitted.
  const { redis, store } = makeFakeRedis();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const nowMs = 1_000_000;
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 1_000,
    now: () => nowMs,
    events: {
      async create(input) {
        events.push(input);
      }
    }
  });

  // Pre-seed Redis as if we were already open and past the cool-down.
  store.set("pii:breaker:pii-llm:state", "open");
  store.set("pii:breaker:pii-llm:openedAt", String(nowMs - 5_000));

  const allowed = await breaker.shouldAllow();
  expect(allowed).toBe(true);
  expect(store.get("pii:breaker:pii-llm:state")).toBe("half_open");
  // openedAt key is cleared because half_open is not "open".
  expect(store.has("pii:breaker:pii-llm:openedAt")).toBe(false);
  // Transition event was emitted.
  expect(events.length).toBe(1);
  expect(events[0]?.payload.from).toBe("open");
  expect(events[0]?.payload.to).toBe("half_open");
});

test("Redis: failures accumulate and trip the breaker at the threshold", async () => {
  const { redis, store } = makeFakeRedis();
  const now = 1_000_000;
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 3,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: () => now
  });

  await breaker.record("failure");
  await breaker.record("failure");
  expect(store.get("pii:breaker:pii-llm:state") ?? "closed").toBe("closed");
  await breaker.record("failure");
  expect(store.get("pii:breaker:pii-llm:state")).toBe("open");
  expect(store.get("pii:breaker:pii-llm:openedAt")).toBe(String(now));
  expect(await breaker.shouldAllow()).toBe(false);
});

test("Redis: failures outside the window do not count toward the threshold", async () => {
  const { redis, store } = makeFakeRedis();
  let now = 1_000_000;
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 3,
    windowMs: 1_000,
    cooldownMs: 30_000,
    now: () => now
  });

  await breaker.record("failure");
  await breaker.record("failure");
  now += 2_000; // outside window
  await breaker.record("failure");
  // Older entries got trimmed; only the latest failure counts → still closed.
  expect(store.get("pii:breaker:pii-llm:state") ?? "closed").toBe("closed");
});

test("Redis: success transitions from half_open to closed and clears failures", async () => {
  const { redis, store, zsets } = makeFakeRedis();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let now = 1_000_000;
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 1_000,
    now: () => now,
    events: { async create(input) { events.push(input); } }
  });

  await breaker.record("failure");
  await breaker.record("failure"); // closed -> open
  expect(store.get("pii:breaker:pii-llm:state")).toBe("open");
  now += 1_000;
  expect(await breaker.shouldAllow()).toBe(true); // -> half_open
  await breaker.record("success"); // -> closed
  expect(store.get("pii:breaker:pii-llm:state")).toBe("closed");
  expect(zsets.get("pii:breaker:pii-llm:failures")?.size ?? 0).toBe(0);
  // closed transition is logged as an event
  expect(events.some((e) => e.payload.to === "closed")).toBe(true);
});

test("Redis: half_open probe failure re-opens immediately", async () => {
  const { redis, store } = makeFakeRedis();
  let now = 1_000_000;
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 1_000,
    now: () => now
  });

  await breaker.record("failure");
  await breaker.record("failure"); // open
  now += 1_000;
  await breaker.shouldAllow(); // half_open
  expect(store.get("pii:breaker:pii-llm:state")).toBe("half_open");
  await breaker.record("failure"); // -> open
  expect(store.get("pii:breaker:pii-llm:state")).toBe("open");
  expect(store.get("pii:breaker:pii-llm:openedAt")).toBe(String(now));
});

test("Redis: record('failure') while open is a no-op", async () => {
  const { redis, store } = makeFakeRedis();
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: () => 1_000_000
  });
  store.set("pii:breaker:pii-llm:state", "open");
  store.set("pii:breaker:pii-llm:openedAt", "999000");
  await breaker.record("failure");
  // Still open, openedAt unchanged
  expect(store.get("pii:breaker:pii-llm:state")).toBe("open");
  expect(store.get("pii:breaker:pii-llm:openedAt")).toBe("999000");
});

test("Redis: snapshot reports state, willRetryAt, and failure count", async () => {
  const { redis } = makeFakeRedis();
  const now = 1_000_000;
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: () => now
  });

  let snap = await breaker.snapshot();
  expect(snap.state).toBe("closed");
  expect(snap.willRetryAt).toBeNull();
  expect(snap.failureCount).toBe(0);

  await breaker.record("failure");
  snap = await breaker.snapshot();
  expect(snap.state).toBe("closed");
  expect(snap.failureCount).toBe(1);

  await breaker.record("failure"); // open
  snap = await breaker.snapshot();
  expect(snap.state).toBe("open");
  expect(snap.openedAt).toBe(now);
  expect(snap.willRetryAt).toBe(now + 30_000);
});

test("Redis: success on already-open transitions to closed (e.g., admin reset path)", async () => {
  const { redis, store } = makeFakeRedis();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: () => 1_000_000,
    events: { async create(input) { events.push(input); } }
  });
  store.set("pii:breaker:pii-llm:state", "open");
  store.set("pii:breaker:pii-llm:openedAt", "999000");

  await breaker.record("success");
  expect(store.get("pii:breaker:pii-llm:state")).toBe("closed");
  expect(events.some((e) => e.payload.from === "open" && e.payload.to === "closed")).toBe(true);
});

test("Redis: errored zcard pipeline result is treated as count=0 (does not trip)", async () => {
  // Contract: if the zcard step in the failure-recording pipeline errors out,
  // the breaker reads count=0 and stays closed. Without this guard a transient
  // Redis failure during a failure-record could itself flip the breaker open.
  //
  // We inject the error by COMMAND NAME ("zcard"), not by a hard-coded result
  // index. The breaker happens to read the card from results[2] today, but the
  // contract under test is "the zcard step errored", not "the third pipeline
  // entry errored" — keeping this by-name means a future reorder of the
  // pipeline ops still exercises the same branch.
  const store = new Map<string, string>();
  const failCommand = "zcard";
  const redis = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return "OK";
    },
    async del(key: string) {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    },
    async zcard() {
      return 0;
    },
    pipeline() {
      // Record the (name, ok-result) of each queued op in call order. exec()
      // then maps each to a result tuple, substituting an error tuple for the
      // op whose name matches `failCommand` — wherever it lands in the chain.
      const ops: Array<{ name: string; ok: unknown }> = [];
      const queue = (name: string, ok: unknown) => {
        ops.push({ name, ok });
        return api;
      };
      const api = {
        zremrangebyscore() { return queue("zremrangebyscore", 1); },
        zadd() { return queue("zadd", "ok"); },
        zcard() { return queue("zcard", 1); },
        pexpire() { return queue("pexpire", 1); },
        set() { return queue("set", "OK"); },
        del() { return queue("del", 1); },
        async exec() {
          return ops.map((op) =>
            op.name === failCommand
              ? [new Error(`${op.name} failed`), null]
              : [null, op.ok]
          );
        }
      };
      return api;
    }
  } as unknown as import("ioredis").Redis;

  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "pii-llm",
    failureThreshold: 1, // would normally trip on the very first failure
    windowMs: 60_000,
    cooldownMs: 30_000,
    now: () => 1_000_000
  });
  await breaker.record("failure");
  // count fell back to 0, which is below threshold=1 → state stays closed.
  expect(store.get("pii:breaker:pii-llm:state") ?? "closed").toBe("closed");
});

test("DisabledPiiCircuitBreaker: always allows, never trips", async () => {
  const breaker = new DisabledPiiCircuitBreaker();
  for (let i = 0; i < 100; i += 1) {
    expect(await breaker.shouldAllow()).toBe(true);
    await breaker.record("failure");
  }
  const snap = await breaker.snapshot();
  expect(snap.state).toBe("closed");
  expect(snap.willRetryAt).toBe(null);
});

test("InMemory: emits a transition event to the configured sink", async () => {
  const clock = makeClock();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "pii-llm",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 1_000,
    now: clock.now,
    events: {
      async create(input) {
        events.push(input);
      }
    }
  });

  await breaker.record("failure");
  await breaker.record("failure"); // closed -> open
  clock.advance(1_000);
  await breaker.shouldAllow(); // open -> half_open
  await breaker.record("success"); // half_open -> closed

  // All events are 'pii_breaker_transition' with provider name + states.
  expect(events.map((e) => ({
          type: e.type,
          from: e.payload.from,
          to: e.payload.to,
          provider: e.payload.provider
        }))).toEqual([
          { type: "pii_breaker_transition", from: "closed", to: "open", provider: "pii-llm" },
          { type: "pii_breaker_transition", from: "open", to: "half_open", provider: "pii-llm" },
          { type: "pii_breaker_transition", from: "half_open", to: "closed", provider: "pii-llm" }
        ]);
});

test("InMemory: a failing event sink does not break the breaker", async () => {
  // The sink runs fire-and-forget; a rejected promise must be caught and
  // surfaced to logger.warn, never thrown into the caller.
  const clock = makeClock();
  const warnings: object[] = [];
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "pii-llm",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 1_000,
    now: clock.now,
    logger: {
      info() {},
      warn(meta) {
        warnings.push(meta);
      }
    },
    events: {
      async create() {
        throw new Error("DB unreachable");
      }
    }
  });

  await breaker.record("failure");
  await breaker.record("failure"); // would emit; sink rejects
  // Wait one tick for the fire-and-forget rejection to land.
  await new Promise((resolve) => setImmediate(resolve));
  expect((await breaker.snapshot()).state).toBe("open");
  expect(warnings.length).toBe(1);
});

test("InMemory: emits a structured log on each transition", async () => {
  const clock = makeClock();
  const transitions: Array<{ from: string; to: string }> = [];
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 1_000,
    now: clock.now,
    logger: {
      info(meta: object) {
        const m = meta as { from: string; to: string };
        transitions.push({ from: m.from, to: m.to });
      },
      warn() {}
    }
  });

  await breaker.record("failure");
  await breaker.record("failure"); // closed -> open
  clock.advance(1_000);
  await breaker.shouldAllow(); // open -> half_open
  await breaker.record("success"); // half_open -> closed

  expect(transitions).toEqual([
        { from: "closed", to: "open" },
        { from: "open", to: "half_open" },
        { from: "half_open", to: "closed" }
      ]);
});
