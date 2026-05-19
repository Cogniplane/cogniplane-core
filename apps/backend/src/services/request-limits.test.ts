import { test, expect } from "vitest";

import { RequestLimits } from "./request-limits.js";

function makeConfig(overrides: {
  userRateLimit?: number;
  tenantRateLimit?: number;
  userQuota?: number;
  tenantQuota?: number;
} = {}) {
  return RequestLimits.fromAppConfig({
    RATE_LIMIT_WINDOW_MS: 60_000,
    SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW: 10,
    SESSION_CREATE_LIMIT_PER_TENANT_PER_WINDOW: 50,
    MESSAGE_LIMIT_PER_USER_PER_WINDOW: overrides.userRateLimit ?? 5,
    MESSAGE_LIMIT_PER_TENANT_PER_WINDOW: overrides.tenantRateLimit ?? 20,
    TURN_QUOTA_PER_USER_PER_DAY: overrides.userQuota ?? 10,
    TURN_QUOTA_PER_TENANT_PER_DAY: overrides.tenantQuota ?? 50
  });
}

test("consumeRateLimit allows requests under the limit", async () => {
  const limits = makeConfig({ userRateLimit: 3 });
  for (let i = 0; i < 3; i++) {
    const result = await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
    expect(result).toBe(null);
  }
});

test("consumeRateLimit rejects when user limit is reached", async () => {
  const limits = makeConfig({ userRateLimit: 2 });
  await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  const result = await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  expect(result !== null).toBeTruthy();
  expect(result.scope).toBe("user");
  expect(result.limitType).toBe("rate_limit");
});

test("consumeRateLimit rolls back counter when tenant limit is exceeded", async () => {
  // Set tenant limit to 1 so the second request hits the tenant cap.
  // The user counter should be rolled back to its pre-call value.
  const limits = makeConfig({ userRateLimit: 10, tenantRateLimit: 1 });

  // First call: both user and tenant incremented, both under limit → allowed.
  const first = await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  expect(first).toBe(null);

  // Second call: user would increment to 2 (under limit=10), tenant would
  // increment to 2 (over limit=1). Both should be rolled back.
  const second = await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  expect(second !== null).toBeTruthy();
  expect(second.scope).toBe("tenant");

  // After rollback, the user counter should still be at 1 (from the first allowed call),
  // so 9 more calls should be allowed before hitting the user limit.
  // But the tenant is still at 1, so the very next call will hit tenant again.
  const third = await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" });
  expect(third !== null).toBeTruthy();
  expect(third.scope).toBe("tenant");
});

test("consumeRateLimit concurrent calls respect the limit", async () => {
  // With limit=2, firing 5 concurrent calls should result in exactly 2 allowed
  // and 3 rejected — the increment-first strategy prevents over-admission.
  const limits = makeConfig({ userRateLimit: 2, tenantRateLimit: 100 });

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" })
    )
  );

  const allowed = results.filter((r) => r === null).length;
  const rejected = results.filter((r) => r !== null).length;
  expect(allowed).toBe(2);
  expect(rejected).toBe(3);
});

test("consumeTurnQuota allows requests under the quota", async () => {
  const limits = makeConfig({ userQuota: 3 });
  const now = new Date("2026-01-15T12:00:00.000Z");
  for (let i = 0; i < 3; i++) {
    const result = await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now });
    expect(result).toBe(null);
  }
});

test("consumeTurnQuota rejects when user quota is reached", async () => {
  const limits = makeConfig({ userQuota: 2 });
  const now = new Date("2026-01-15T12:00:00.000Z");
  await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now });
  await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now });
  const result = await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now });
  expect(result !== null).toBeTruthy();
  expect(result.scope).toBe("user");
  expect(result.limitType).toBe("usage_quota");
});

test("consumeTurnQuota rolls back counter when tenant quota is exceeded", async () => {
  const limits = makeConfig({ userQuota: 10, tenantQuota: 1 });
  const now = new Date("2026-01-15T12:00:00.000Z");

  const first = await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now });
  expect(first).toBe(null);

  const second = await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now });
  expect(second !== null).toBeTruthy();
  expect(second.scope).toBe("tenant");

  // After rollback, tenant is still at 1 — next call also rejected.
  const third = await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now });
  expect(third !== null).toBeTruthy();
  expect(third.scope).toBe("tenant");
});

test("consumeTurnQuota concurrent calls respect the quota", async () => {
  const limits = makeConfig({ userQuota: 2, tenantQuota: 100 });
  const now = new Date("2026-01-15T12:00:00.000Z");

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now })
    )
  );

  const allowed = results.filter((r) => r === null).length;
  const rejected = results.filter((r) => r !== null).length;
  expect(allowed).toBe(2);
  expect(rejected).toBe(3);
});
