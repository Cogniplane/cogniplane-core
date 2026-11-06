import { describe, expect, test } from "vitest";

import { FakeRefreshTokenRedis } from "../../test-helpers/fake-refresh-token-redis.js";
import { LOGIN_FLOW_MAX_FAILURES, LOGIN_FLOW_TTL_SECONDS, LoginFlowStore } from "./login-flow-store.js";

const FLOW = { tenantId: "t", userId: "u", email: "a@b.co", securityVersion: 3, amr: ["pwd" as const], purpose: "mfa" as const };

describe("LoginFlowStore", () => {
  test("stores only a hash of the id; the browser's id reads it back", async () => {
    const redis = new FakeRefreshTokenRedis();
    const store = new LoginFlowStore(redis);
    const id = (await store.create(FLOW))!;
    const [key] = [...redis.store.keys()];
    expect(key).toMatch(/^login_flow:[0-9a-f]{64}$/);
    expect(key).not.toContain(id);
    expect(await store.read(id)).toMatchObject(FLOW);
  });

  test("consume works once", async () => {
    const store = new LoginFlowStore(new FakeRefreshTokenRedis());
    const id = (await store.create(FLOW))!;
    expect(await store.consume(id)).toMatchObject(FLOW);
    expect(await store.consume(id)).toBeNull();
    expect(await store.read(id)).toBeNull();
  });

  test("ends after the maximum number of wrong codes", async () => {
    const store = new LoginFlowStore(new FakeRefreshTokenRedis());
    const id = (await store.create(FLOW))!;
    for (let i = 0; i < LOGIN_FLOW_MAX_FAILURES; i += 1) {
      // As a step does: take the flow, then put it back with the failure.
      const flow = await store.consume(id);
      expect(flow).not.toBeNull();
      await store.restore(id, flow!, { failure: true });
    }
    expect(await store.read(id)).toBeNull();
  });

  test("a put-back without a failure does not count", async () => {
    const store = new LoginFlowStore(new FakeRefreshTokenRedis());
    const id = (await store.create(FLOW))!;
    for (let i = 0; i < LOGIN_FLOW_MAX_FAILURES + 1; i += 1) await store.restore(id, (await store.consume(id))!);
    expect(await store.read(id)).not.toBeNull();
  });

  test("ends at its deadline", async () => {
    let now = 1_000_000;
    const store = new LoginFlowStore(new FakeRefreshTokenRedis(), () => now);
    const id = (await store.create(FLOW))!;
    now += (LOGIN_FLOW_TTL_SECONDS + 1) * 1000;
    expect(await store.read(id)).toBeNull();
  });

  test("a follow-up flow keeps the first flow's deadline", async () => {
    let now = 1_000_000;
    const redis = new FakeRefreshTokenRedis();
    const store = new LoginFlowStore(redis, () => now);
    const first = (await store.create(FLOW))!;
    const flow = (await store.consume(first))!;
    now += 200_000;
    const next = (await store.create({ ...FLOW, purpose: "recover" }, flow.createdAtMs))!;
    expect(redis.setCalls.at(-1)?.ttlSeconds).toBe(LOGIN_FLOW_TTL_SECONDS - 200);
    now += (LOGIN_FLOW_TTL_SECONDS - 200 + 1) * 1000;
    expect(await store.read(next)).toBeNull();
    // A deadline that has passed starts nothing.
    expect(await store.create(FLOW, flow.createdAtMs)).toBeNull();
  });



  test.each([undefined, "short", 42])("refuses a malformed id %j", async (id) => {
    expect(await new LoginFlowStore(new FakeRefreshTokenRedis()).read(id)).toBeNull();
  });

  test("restore puts back a taken flow with its deadline, and nothing after it", async () => {
    let now = 1_000_000;
    const redis = new FakeRefreshTokenRedis();
    const store = new LoginFlowStore(redis, () => now);
    const id = (await store.create(FLOW))!;
    const flow = (await store.consume(id))!;
    now += 100_000;
    await store.restore(id, flow);
    expect(await store.read(id)).toEqual(flow);
    const flowKey = [...redis.store.keys()].find((key) => key.startsWith("login_flow:"))!;
    expect(redis.ttlMs.get(flowKey)).toBe((LOGIN_FLOW_TTL_SECONDS - 100) * 1000);
    await store.consume(id);
    now += LOGIN_FLOW_TTL_SECONDS * 1000;
    await store.restore(id, flow);
    expect(await store.read(id)).toBeNull();
  });
});
