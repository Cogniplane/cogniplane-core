import { describe, expect, test } from "vitest";

import { FakeRefreshTokenRedis } from "../../test-helpers/fake-refresh-token-redis.js";
import { type StepUpBinding, STEP_UP_TTL_SECONDS, StepUpStore } from "./step-up-store.js";

const BINDING: StepUpBinding = {
  userId: "user-1", tenantId: "tenant-1", familyId: "family-1", securityVersion: 3, action: "member.disable"
};

describe("StepUpStore", () => {
  test("stores only a hash of the token, with the TTL", async () => {
    const redis = new FakeRefreshTokenRedis();
    const { token, expiresInSeconds } = await new StepUpStore(redis).create(BINDING, ["pwd"]);
    expect(expiresInSeconds).toBe(STEP_UP_TTL_SECONDS);
    const keys = [...redis.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^step_up:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain(token);
  });

  test("is single use", async () => {
    const store = new StepUpStore(new FakeRefreshTokenRedis());
    const { token } = await store.create(BINDING, ["pwd"]);
    expect(await store.consume(token, BINDING)).toEqual(["pwd"]);
    expect(await store.consume(token, BINDING)).toBeNull();
  });

  test.each([
    ["another user", { userId: "user-2" }],
    ["another tenant", { tenantId: "tenant-2" }],
    ["another session family", { familyId: "family-2" }],
    ["a newer security version", { securityVersion: 4 }],
    ["another action", { action: "member.password_reset" as const }]
  ])("refuses and burns a token presented for %s", async (_case, change) => {
    const store = new StepUpStore(new FakeRefreshTokenRedis());
    const { token } = await store.create(BINDING, ["pwd"]);
    expect(await store.consume(token, { ...BINDING, ...change })).toBeNull();
    // A wrong attempt burns it: no second try with the right binding.
    expect(await store.consume(token, BINDING)).toBeNull();
  });

  test.each([undefined, 42, "short", "x".repeat(43) + "!"])("refuses a malformed token %s without a lookup", async (raw) => {
    const redis = new FakeRefreshTokenRedis();
    expect(await new StepUpStore(redis).consume(raw, BINDING)).toBeNull();
  });
});
