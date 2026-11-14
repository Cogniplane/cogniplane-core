// The Redis PII circuit breaker on a real Redis server: the same contract as
// the in-memory breaker, and the cases that need shared state. Several
// breakers on one key prefix stand for several replicas.

import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import { describe, expect, onTestFinished, test } from "vitest";

import { RedisPiiCircuitBreaker, type BreakerPermit } from "../services/pii/pii-circuit-breaker.js";
import { describeBreakerContract, makeClock, type BreakerFactoryOptions } from "../test-helpers/pii-breaker-contract.js";

if (process.env.INTEGRATION_REQUIRE_REDIS === "1" && !process.env.INTEGRATION_REDIS_URL) {
  throw new Error("INTEGRATION_REQUIRE_REDIS=1 but INTEGRATION_REDIS_URL is not set.");
}

/** One Redis client and key prefix per test; the keys are deleted after it. */
function namespace() {
  const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
  const keyPrefix = `pii:breaker:test:${randomUUID()}`;
  onTestFinished(async () => {
    try {
      const keys = await redis.keys(`${keyPrefix}:*`);
      if (keys.length) await redis.del(...keys);
    } finally {
      await redis.quit();
    }
  });
  const make = (options: BreakerFactoryOptions) =>
    new RedisPiiCircuitBreaker(redis, { name: "pii-llm", keyPrefix, ...options });
  return { redis, keyPrefix, make };
}

async function permitOf(admission: Awaited<ReturnType<RedisPiiCircuitBreaker["admit"]>>): Promise<BreakerPermit> {
  if (!admission.allowed) throw new Error("expected an admission");
  return admission.permit;
}

describe.skipIf(!process.env.INTEGRATION_REDIS_URL)("Redis PII circuit breaker", () => {
  describeBreakerContract("Redis", (options) => namespace().make(options));

  test("replicas that ask at the same time after the cool-down get exactly one probe", async () => {
    const { make } = namespace();
    const clock = makeClock();
    const options = { failureThreshold: 2, windowMs: 60_000, cooldownMs: 1_000, probeTtlMs: 5_000, now: clock.now };
    const replicas = [make(options), make(options), make(options)];
    for (const replica of replicas.slice(0, 2)) {
      await replica.record(await permitOf(await replica.admit()), "failure");
    }
    expect((await replicas[2]!.snapshot()).state).toBe("open");

    clock.advance(1_000);
    const admissions = await Promise.all(
      Array.from({ length: 30 }, (_, index) => replicas[index % 3]!.admit())
    );
    const probes = admissions.filter((admission) => admission.allowed);
    expect(probes).toHaveLength(1);
    expect((await replicas[0]!.snapshot()).state).toBe("half_open");
  });

  test("a slow success or failure from another replica cannot decide after the state moved on", async () => {
    const { make } = namespace();
    const clock = makeClock();
    const options = { failureThreshold: 2, windowMs: 60_000, cooldownMs: 1_000, probeTtlMs: 5_000, now: clock.now };
    const [a, b] = [make(options), make(options)];
    const slowSuccess = await permitOf(await a.admit());
    const slowFailure = await permitOf(await a.admit());
    for (let i = 0; i < 2; i += 1) await b.record(await permitOf(await b.admit()), "failure");
    await a.record(slowSuccess, "success");
    expect((await b.snapshot()).state).toBe("open");

    clock.advance(1_000);
    const probe = await permitOf(await b.admit());
    await a.record(slowSuccess, "success");
    await a.record(slowFailure, "failure");
    expect((await a.snapshot()).state).toBe("half_open");
    await b.record(probe, "success");
    expect(await a.snapshot()).toMatchObject({ state: "closed", failureCount: 0 });
    // A late failure of a closed generation does not count in the new one.
    await a.record(slowFailure, "failure");
    expect((await a.snapshot()).failureCount).toBe(0);
  });

  test("a probe whose replica died expires, and another replica can probe", async () => {
    const { make } = namespace();
    const clock = makeClock();
    const options = { failureThreshold: 1, windowMs: 60_000, cooldownMs: 1_000, probeTtlMs: 2_000, now: clock.now };
    const [dying, survivor] = [make(options), make(options)];
    await dying.record(await permitOf(await dying.admit()), "failure");
    clock.advance(1_000);
    await permitOf(await dying.admit());
    // The replica stops here: no outcome, no release.
    expect(await survivor.admit()).toEqual({ allowed: false });
    clock.advance(2_000);
    const probe = await permitOf(await survivor.admit());
    expect(probe.probe).not.toBeNull();
    await survivor.record(probe, "success");
    expect((await survivor.snapshot()).state).toBe("closed");
  });

  test("after the keys are lost, permits from before do not match the new state", async () => {
    const { redis, keyPrefix, make } = namespace();
    const clock = makeClock();
    const options = { failureThreshold: 1, windowMs: 60_000, cooldownMs: 1_000, probeTtlMs: 5_000, now: clock.now };
    const breaker = make(options);
    const before = await permitOf(await breaker.admit());
    expect(before.generation).toMatch(/:0$/);
    await redis.del(`${keyPrefix}:{pii-llm}:state`, `${keyPrefix}:{pii-llm}:failures`);

    // The next admission starts a new hash: generation 0 again, a new epoch.
    const after = await permitOf(await breaker.admit());
    expect(after.generation).toMatch(/:0$/);
    expect(after.generation).not.toBe(before.generation);
    await breaker.record(after, "failure");
    expect((await breaker.snapshot()).state).toBe("open");
    // The old permit does not reach the new state at any generation.
    clock.advance(1_000);
    const probe = await permitOf(await breaker.admit());
    await breaker.record(before, "success");
    await breaker.record({ generation: before.generation.replace(/:0$/, ":2"), probe: probe.probe }, "success");
    expect((await breaker.snapshot()).state).toBe("half_open");
  });

  test("the state and the failures share one hash tag", async () => {
    const { redis, keyPrefix, make } = namespace();
    const breaker = make({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 1_000, now: Date.now });
    await breaker.record(await permitOf(await breaker.admit()), "failure");
    const keys = (await redis.keys(`${keyPrefix}:*`)).sort();
    expect(keys).toEqual([`${keyPrefix}:{pii-llm}:failures`, `${keyPrefix}:{pii-llm}:state`]);
    const slots = await Promise.all(keys.map((key) => redis.call("CLUSTER", "KEYSLOT", key).catch(() => null)));
    // CLUSTER KEYSLOT answers also on a server that is not a cluster.
    if (slots[0] !== null) expect(slots[0]).toBe(slots[1]);
  });
});
