import { describe, expect, test } from "vitest";

import {
  InMemoryLoginThrottle,
  MAX_IN_FLIGHT,
  THROTTLE_BASE_DELAY_MS,
  THROTTLE_MAX_DELAY_MS,
  THROTTLE_THRESHOLD,
  throttleDelayMs
} from "./login-throttle.js";

describe("throttleDelayMs", () => {
  test("starts at the threshold, doubles, and stops at the maximum", () => {
    expect(throttleDelayMs(THROTTLE_THRESHOLD - 1)).toBe(0);
    expect(throttleDelayMs(THROTTLE_THRESHOLD)).toBe(THROTTLE_BASE_DELAY_MS);
    expect(throttleDelayMs(THROTTLE_THRESHOLD + 1)).toBe(THROTTLE_BASE_DELAY_MS * 2);
    expect(throttleDelayMs(THROTTLE_THRESHOLD + 20)).toBe(THROTTLE_MAX_DELAY_MS);
  });
});

describe("InMemoryLoginThrottle", () => {
  function setup() {
    let now = 1_000_000;
    const throttle = new InMemoryLoginThrottle(() => now);
    return { throttle, advance: (ms: number) => { now += ms; } };
  }

  async function fail(throttle: InMemoryLoginThrottle, email: string) {
    const admission = await throttle.admit("password", email);
    if (!admission.admitted) throw new Error("expected admission");
    await throttle.complete(admission.ticket, "failure");
  }

  test("throttles after the threshold, and refused requests do not move the deadline", async () => {
    const { throttle, advance } = setup();
    for (let i = 0; i < THROTTLE_THRESHOLD; i += 1) await fail(throttle, "a@example.com");

    const refused = await throttle.admit("password", "a@example.com");
    expect(refused).toEqual({ admitted: false, retryAfterMs: THROTTLE_BASE_DELAY_MS });
    advance(10_000);
    // Many refused tries: the wait shrinks, it never grows.
    for (let i = 0; i < 20; i += 1) await throttle.admit("password", "a@example.com");
    expect(await throttle.admit("password", "a@example.com")).toEqual({
      admitted: false, retryAfterMs: THROTTLE_BASE_DELAY_MS - 10_000
    });

    advance(THROTTLE_BASE_DELAY_MS);
    expect((await throttle.admit("password", "a@example.com")).admitted).toBe(true);
    // Another identifier was never affected.
    expect((await throttle.admit("password", "b@example.com")).admitted).toBe(true);
  });

  test("a success clears the record", async () => {
    const { throttle } = setup();
    for (let i = 0; i < THROTTLE_THRESHOLD - 1; i += 1) await fail(throttle, "c@example.com");
    const admission = await throttle.admit("password", "c@example.com");
    if (!admission.admitted) throw new Error("expected admission");
    await throttle.complete(admission.ticket, "success");
    expect(throttle.records.size).toBe(0);
  });

  test("limits verifications in flight, and an aborted one frees its slot without counting", async () => {
    const { throttle } = setup();
    const tickets = [];
    for (let i = 0; i < MAX_IN_FLIGHT; i += 1) {
      const admission = await throttle.admit("password", "d@example.com");
      if (!admission.admitted) throw new Error("expected admission");
      tickets.push(admission.ticket);
    }
    expect((await throttle.admit("password", "d@example.com")).admitted).toBe(false);

    await throttle.complete(tickets[0]!, "aborted");
    expect(throttle.records.get(tickets[0]!.key)?.fails).toBe(0);
    expect((await throttle.admit("password", "d@example.com")).admitted).toBe(true);
  });
});
