import { describe, expect, test } from "vitest";

import { FakeRefreshTokenRedis } from "../../test-helpers/fake-refresh-token-redis.js";
import { flowKeyOf, PASSKEY_CHALLENGE_TTL_SECONDS, PasskeyChallengeStore } from "./passkey-challenge-store.js";

describe("PasskeyChallengeStore", () => {
  test("stores only a hash of the id, with a TTL; a record works once", async () => {
    const redis = new FakeRefreshTokenRedis();
    const store = new PasskeyChallengeStore(redis);
    const id = await store.create({ challenge: "c", purpose: "login" });
    const [key] = [...redis.store.keys()];
    expect(key).toMatch(/^passkey_challenge:[0-9a-f]{64}$/);
    expect(key).not.toContain(id);
    expect(redis.setCalls[0]?.ttlSeconds).toBe(PASSKEY_CHALLENGE_TTL_SECONDS);
    expect(await store.consume(id, "login")).toMatchObject({ challenge: "c", purpose: "login" });
    expect(await store.consume(id, "login")).toBeNull();
  });

  test("a record of one purpose never serves another, and is spent by the try", async () => {
    const store = new PasskeyChallengeStore(new FakeRefreshTokenRedis());
    const id = await store.create({ challenge: "c", purpose: "step_up", userId: "u" });
    expect(await store.consume(id, "login")).toBeNull();
    expect(await store.consume(id, "step_up")).toBeNull();
  });

  test("an old record is refused", async () => {
    let now = 1_000_000;
    const store = new PasskeyChallengeStore(new FakeRefreshTokenRedis(), () => now);
    const id = await store.create({ challenge: "c", purpose: "register" });
    now += (PASSKEY_CHALLENGE_TTL_SECONDS + 1) * 1000;
    expect(await store.consume(id, "register")).toBeNull();
  });

  test.each([undefined, "short", 42])("refuses a malformed id %j", async (id) => {
    expect(await new PasskeyChallengeStore(new FakeRefreshTokenRedis()).consume(id, "login")).toBeNull();
  });

  test("the flow binding key is not the flow id", () => {
    expect(flowKeyOf("flow-id")).toMatch(/^[0-9a-f]{64}$/);
    expect(flowKeyOf("flow-id")).not.toBe(flowKeyOf("flow-id2"));
  });
});
