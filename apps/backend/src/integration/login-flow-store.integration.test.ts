import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, onTestFinished, test } from "vitest";

import { LOGIN_FLOW_MAX_FAILURES, LoginFlowStore } from "../services/auth/login-flow-store.js";

// The failure script of the sign-in flow against a real Redis
// (docs/ARCHITECTURE.md, "Authentication"): a wrong code never brings back
// a consumed flow, and every concurrent failure counts.

if (process.env.INTEGRATION_REQUIRE_REDIS === "1" && !process.env.INTEGRATION_REDIS_URL) {
  throw new Error("INTEGRATION_REQUIRE_REDIS=1 but INTEGRATION_REDIS_URL is not set.");
}

const FLOW = { tenantId: "t", userId: "u", email: "a@b.co", securityVersion: 3, amr: ["pwd" as const], purpose: "mfa" as const };

/** The keys of one flow; each test deletes only its own (Redis may be shared). */
function keysOf(flowId: string) {
  const hash = createHash("sha256").update(flowId, "utf8").digest("hex");
  return { flow: `login_flow:${hash}`, failures: `login_flow_failures:${hash}` };
}

function setup() {
  const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
  const created: string[] = [];
  onTestFinished(async () => {
    const keys = created.flatMap((id) => Object.values(keysOf(id)));
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });
  const store = new LoginFlowStore(redis);
  const create = async () => {
    const id = (await store.create(FLOW))!;
    created.push(id);
    return id;
  };
  return { redis, store, create };
}

describe.skipIf(!process.env.INTEGRATION_REDIS_URL)("sign-in flow in Redis", () => {
  test("a counted put-back is one step: each failure counts, and the last one ends the flow", async () => {
    const { redis, store, create } = setup();
    const id = await create();
    for (let i = 0; i < LOGIN_FLOW_MAX_FAILURES - 1; i += 1) {
      const taken = (await store.consume(id))!;
      // A parallel request between take and put-back finds nothing to take.
      expect(await store.consume(id)).toBeNull();
      await store.restore(id, taken, { failure: true });
    }
    expect(Number(await redis.get(keysOf(id).failures))).toBe(LOGIN_FLOW_MAX_FAILURES - 1);
    expect(await redis.ttl(keysOf(id).failures)).toBeGreaterThan(0);
    expect(await redis.ttl(keysOf(id).flow)).toBeGreaterThan(0);
    await store.restore(id, (await store.consume(id))!, { failure: true });
    expect(await store.read(id)).toBeNull();
    expect(await redis.exists(keysOf(id).failures)).toBe(0);
  });

  test("concurrent takes of one flow: exactly one request gets it; a restore keeps its deadline", async () => {
    const { redis, store, create } = setup();
    const id = await create();
    const taken = await Promise.all([store.consume(id), store.consume(id), store.consume(id)]);
    expect(taken.filter(Boolean)).toHaveLength(1);
    const flow = taken.find(Boolean)!;
    await store.restore(id, flow);
    expect(await store.read(id)).toEqual(flow);
    expect(await redis.ttl(keysOf(id).flow)).toBeGreaterThan(0);
  });
});
