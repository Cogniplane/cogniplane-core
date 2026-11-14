import { expect, test } from "vitest";

import type { Redis } from "ioredis";

import {
  DisabledPiiCircuitBreaker,
  InMemoryPiiCircuitBreaker,
  RedisPiiCircuitBreaker
} from "./pii-circuit-breaker.js";
import { describeBreakerContract, makeClock } from "../../test-helpers/pii-breaker-contract.js";

// The Redis breaker runs the same contract against a real Redis server in
// integration/pii-circuit-breaker-redis.integration.test.ts.
describeBreakerContract("InMemory", (options) => new InMemoryPiiCircuitBreaker({ name: "test", ...options }));

test("Redis breaker outage permits scanning with an untracked permit and warns once", async () => {
  const warnings: string[] = [];
  const calls: string[] = [];
  const redis = {
    eval: async (script: string) => {
      calls.push(script.includes("probeUntil") ? "eval" : "other");
      throw new Error("offline");
    }
  } as unknown as Redis;
  const breaker = new RedisPiiCircuitBreaker(redis, {
    name: "test", failureThreshold: 2, windowMs: 1000, cooldownMs: 1000,
    logger: { info() {}, warn(_meta, message) { warnings.push(message); } }
  });
  const admission = await breaker.admit();
  expect(admission).toEqual({ allowed: true, permit: { generation: "", probe: null } });
  if (!admission.allowed) throw new Error("unreachable");
  // The untracked permit does not reach Redis.
  await expect(breaker.record(admission.permit, "failure")).resolves.toBeUndefined();
  await expect(breaker.release(admission.permit)).resolves.toBeUndefined();
  expect(calls).toEqual(["eval"]);
  expect(warnings).toEqual(["PII breaker store unavailable; provider scanning continues"]);
});

test("Redis breaker keys share one hash tag, so a Redis Cluster keeps them in one slot", async () => {
  const keys: string[][] = [];
  const redis = {
    eval: async (_script: string, numKeys: number, ...args: string[]) => {
      keys.push(args.slice(0, numKeys));
      return numKeys === 1 ? [1, "epoch-1", "0", "", ""] : ["ok"];
    }
  } as unknown as Redis;
  const breaker = new RedisPiiCircuitBreaker(redis, { name: "pii-llm", failureThreshold: 2, windowMs: 1000, cooldownMs: 1000 });
  const admission = await breaker.admit();
  if (!admission.allowed) throw new Error("expected an admission");
  expect(admission.permit).toEqual({ generation: "epoch-1:0", probe: null });
  await breaker.record(admission.permit, "failure");
  expect(keys).toEqual([
    ["pii:breaker:{pii-llm}:state"],
    ["pii:breaker:{pii-llm}:state", "pii:breaker:{pii-llm}:failures"]
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

  for (let i = 0; i < 2; i += 1) {
    const admission = await breaker.admit();
    if (!admission.allowed) throw new Error("expected an admission");
    await breaker.record(admission.permit, "failure"); // the second one would emit; the sink rejects
  }
  // Wait one tick for the fire-and-forget rejection to land.
  await new Promise((resolve) => setImmediate(resolve));
  expect((await breaker.snapshot()).state).toBe("open");
  expect(warnings.length).toBe(1);
});

test("DisabledPiiCircuitBreaker: always allows, never trips", async () => {
  const breaker = new DisabledPiiCircuitBreaker();
  for (let i = 0; i < 100; i += 1) {
    const admission = await breaker.admit();
    expect(admission.allowed).toBe(true);
    if (admission.allowed) await breaker.record(admission.permit, "failure");
  }
  const snap = await breaker.snapshot();
  expect(snap.state).toBe("closed");
  expect(snap.willRetryAt).toBe(null);
});
