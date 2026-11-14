import { expect, test } from "vitest";

import type {
  BreakerEventSink,
  BreakerPermit,
  PiiCircuitBreaker
} from "../services/pii/pii-circuit-breaker.js";

export type BreakerFactoryOptions = {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  probeTtlMs?: number;
  now: () => number;
  events?: BreakerEventSink;
};

/** Makes a breaker. Two calls with the same options share state when the backend shares it. */
export type BreakerFactory = (options: BreakerFactoryOptions) => Promise<PiiCircuitBreaker> | PiiCircuitBreaker;

export function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

async function permitOf(breaker: PiiCircuitBreaker): Promise<BreakerPermit> {
  const admission = await breaker.admit();
  if (!admission.allowed) throw new Error("expected the breaker to admit the call");
  return admission.permit;
}

async function fail(breaker: PiiCircuitBreaker, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) await breaker.record(await permitOf(breaker), "failure");
}

/**
 * Behavior that every tracked breaker (in memory, Redis) must have. `label`
 * prefixes the test names.
 */
export function describeBreakerContract(label: string, make: BreakerFactory): void {
  const base = { failureThreshold: 2, windowMs: 60_000, cooldownMs: 1_000, probeTtlMs: 5_000 };

  test(`${label}: closed admits, counts failures in the window and trips at the threshold`, async () => {
    const clock = makeClock();
    const breaker = await make({ ...base, failureThreshold: 3, windowMs: 1_000, now: clock.now });
    await fail(breaker, 2);
    clock.advance(2_000);
    await fail(breaker, 1);
    // The first two left the window.
    expect((await breaker.snapshot()).state).toBe("closed");
    await fail(breaker, 2);
    const snapshot = await breaker.snapshot();
    expect(snapshot).toMatchObject({ state: "open", openedAt: clock.now(), willRetryAt: clock.now() + 1_000 });
    expect(await breaker.admit()).toEqual({ allowed: false });
  });

  test(`${label}: a success in closed state resets the failure count`, async () => {
    const clock = makeClock();
    const breaker = await make({ ...base, failureThreshold: 3, now: clock.now });
    await fail(breaker, 2);
    await breaker.record(await permitOf(breaker), "success");
    await fail(breaker, 1);
    expect(await breaker.snapshot()).toMatchObject({ state: "closed", failureCount: 1 });
  });

  test(`${label}: after the cool-down exactly one probe runs, and its success closes`, async () => {
    const clock = makeClock();
    const breaker = await make({ ...base, now: clock.now });
    await fail(breaker, 2);
    clock.advance(1_000);
    const probe = await permitOf(breaker);
    expect(probe.probe).not.toBeNull();
    expect((await breaker.snapshot()).state).toBe("half_open");
    // A second caller is refused while the probe runs.
    expect(await breaker.admit()).toEqual({ allowed: false });
    await breaker.record(probe, "success");
    expect(await breaker.snapshot()).toMatchObject({ state: "closed", failureCount: 0 });
    expect((await breaker.admit()).allowed).toBe(true);
  });

  test(`${label}: a failed probe reopens with a new cool-down`, async () => {
    const clock = makeClock();
    const breaker = await make({ ...base, now: clock.now });
    await fail(breaker, 2);
    clock.advance(1_000);
    const probe = await permitOf(breaker);
    clock.advance(200);
    await breaker.record(probe, "failure");
    expect(await breaker.snapshot()).toMatchObject({
      state: "open", openedAt: clock.now(), willRetryAt: clock.now() + 1_000
    });
    clock.advance(999);
    expect(await breaker.admit()).toEqual({ allowed: false });
  });

  test(`${label}: an outcome of a call admitted before the breaker opened changes nothing`, async () => {
    const clock = makeClock();
    const breaker = await make({ ...base, now: clock.now });
    const slow = await permitOf(breaker);
    const slowFailure = await permitOf(breaker);
    await fail(breaker, 2);
    // A slow success from before the outage does not close the open breaker.
    await breaker.record(slow, "success");
    expect((await breaker.snapshot()).state).toBe("open");
    clock.advance(1_000);
    const probe = await permitOf(breaker);
    // Nor can it decide the half-open state: only the probe can.
    await breaker.record(slow, "success");
    await breaker.record(slowFailure, "failure");
    expect((await breaker.snapshot()).state).toBe("half_open");
    await breaker.record(probe, "failure");
    expect((await breaker.snapshot()).state).toBe("open");
    // After the probe reopened it, the probe's permit is stale too.
    await breaker.record(probe, "success");
    expect((await breaker.snapshot()).state).toBe("open");
  });

  test(`${label}: a released probe lets the next caller probe`, async () => {
    const clock = makeClock();
    const breaker = await make({ ...base, now: clock.now });
    await fail(breaker, 2);
    clock.advance(1_000);
    const aborted = await permitOf(breaker);
    await breaker.release(aborted);
    const next = await permitOf(breaker);
    expect(next.probe).not.toBeNull();
    expect(next.probe).not.toBe(aborted.probe);
    // The released permit decides nothing.
    await breaker.record(aborted, "success");
    expect((await breaker.snapshot()).state).toBe("half_open");
    await breaker.record(next, "success");
    expect((await breaker.snapshot()).state).toBe("closed");
  });

  test(`${label}: a probe that gives no outcome expires, and its late outcome is refused`, async () => {
    const clock = makeClock();
    const breaker = await make({ ...base, now: clock.now });
    await fail(breaker, 2);
    clock.advance(1_000);
    const dead = await permitOf(breaker);
    clock.advance(4_999);
    expect(await breaker.admit()).toEqual({ allowed: false });
    clock.advance(1);
    const next = await permitOf(breaker);
    expect(next.probe).not.toBe(dead.probe);
    await breaker.record(dead, "success");
    expect((await breaker.snapshot()).state).toBe("half_open");
    await breaker.record(next, "failure");
    expect((await breaker.snapshot()).state).toBe("open");
  });

  test(`${label}: each transition goes to the event sink once`, async () => {
    const clock = makeClock();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const breaker = await make({
      ...base, now: clock.now, events: { async create(input) { events.push(input); } }
    });
    await fail(breaker, 2);
    clock.advance(1_000);
    const probe = await permitOf(breaker);
    expect(await breaker.admit()).toEqual({ allowed: false });
    await breaker.record(probe, "success");
    await breaker.record(probe, "success");
    expect(events.map((event) => [event.type, event.payload.from, event.payload.to])).toEqual([
      ["pii_breaker_transition", "closed", "open"],
      ["pii_breaker_transition", "open", "half_open"],
      ["pii_breaker_transition", "half_open", "closed"]
    ]);
  });
}
