import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, onTestFinished, test } from "vitest";

import {
  MAX_IN_FLIGHT,
  RedisLoginThrottle,
  THROTTLE_BASE_DELAY_MS,
  THROTTLE_RECORD_TTL_MS,
  THROTTLE_THRESHOLD
} from "../services/auth/login-throttle.js";

// The Lua scripts of the sign-in throttle against a real Redis
// (docs/architecture/auth.md). The in-memory twin has
// unit tests; this proves the scripts keep the same rules.

if (process.env.INTEGRATION_REQUIRE_REDIS === "1" && !process.env.INTEGRATION_REDIS_URL) {
  throw new Error("INTEGRATION_REQUIRE_REDIS=1 but INTEGRATION_REDIS_URL is not set.");
}

const SECRET = "login-throttle-integration-secret-at-least-32";

function setup() {
  const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
  const throttle = new RedisLoginThrottle(redis, SECRET);
  const email = `${randomUUID()}@example.test`;
  const keys: string[] = [];
  onTestFinished(async () => {
    try {
      if (keys.length) await redis.del(...keys);
    } finally {
      await redis.quit();
    }
  });
  return { redis, throttle, email, track: (key: string) => keys.push(`login_throttle:password:${key}`, `login_in_flight:password:${key}`) };
}

describe.skipIf(!process.env.INTEGRATION_REDIS_URL)("sign-in throttle in Redis", () => {
  test("throttles after the threshold; refused requests do not extend the wait; keys hold no email", async () => {
    const { redis, throttle, email, track } = setup();
    let recordKey = "";
    for (let i = 0; i < THROTTLE_THRESHOLD; i += 1) {
      const admission = await throttle.admit("password", email);
      if (!admission.admitted) throw new Error(`refused at failure ${i}`);
      track(admission.ticket.key);
      recordKey = `login_throttle:password:${admission.ticket.key}`;
      await throttle.complete(admission.ticket, "failure");
    }

    const first = await throttle.admit("password", email);
    expect(first.admitted).toBe(false);
    if (first.admitted) return;
    expect(first.retryAfterMs).toBeGreaterThan(THROTTLE_BASE_DELAY_MS - 2_000);
    expect(first.retryAfterMs).toBeLessThanOrEqual(THROTTLE_BASE_DELAY_MS);

    for (let i = 0; i < 10; i += 1) await throttle.admit("password", email);
    const later = await throttle.admit("password", email);
    expect(later.admitted).toBe(false);
    if (!later.admitted) expect(later.retryAfterMs).toBeLessThanOrEqual(first.retryAfterMs);

    // The key is an HMAC, never the address.
    expect(recordKey).not.toContain(email.split("@")[0]!);
    expect(await redis.pttl(recordKey)).toBeGreaterThan(THROTTLE_RECORD_TTL_MS - 60_000);
  });

  test("limits verifications in flight; aborted frees a slot without counting; success clears", async () => {
    const { redis, throttle, email, track } = setup();
    const tickets = [];
    for (let i = 0; i < MAX_IN_FLIGHT; i += 1) {
      const admission = await throttle.admit("password", email);
      if (!admission.admitted) throw new Error("expected admission");
      track(admission.ticket.key);
      tickets.push(admission.ticket);
    }
    expect((await throttle.admit("password", email)).admitted).toBe(false);

    await throttle.complete(tickets[0]!, "aborted");
    const recordKey = `login_throttle:password:${tickets[0]!.key}`;
    expect(await redis.hget(recordKey, "fails")).toBeNull();
    await throttle.complete(tickets[1]!, "failure");
    expect(await redis.hget(recordKey, "fails")).toBe("1");

    const admission = await throttle.admit("password", email);
    if (!admission.admitted) throw new Error("expected admission");
    await throttle.complete(admission.ticket, "success");
    expect(await redis.exists(recordKey)).toBe(0);
  });
});
