import { test, expect } from "vitest";

import { createTestConfig } from "../test-helpers/test-config.js";
import { RequestLimits } from "./request-limits.js";

function makeConfig(overrides: {
  userRateLimit?: number;
  tenantRateLimit?: number;
  userQuota?: number;
  tenantQuota?: number;
} = {}) {
  return RequestLimits.fromAppConfig(createTestConfig({
    RATE_LIMIT_WINDOW_MS: 60_000,
    SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW: 10,
    SESSION_CREATE_LIMIT_PER_TENANT_PER_WINDOW: 50,
    MESSAGE_LIMIT_PER_USER_PER_WINDOW: overrides.userRateLimit ?? 5,
    MESSAGE_LIMIT_PER_TENANT_PER_WINDOW: overrides.tenantRateLimit ?? 20,
    TURN_QUOTA_PER_USER_PER_DAY: overrides.userQuota ?? 10,
    TURN_QUOTA_PER_TENANT_PER_DAY: overrides.tenantQuota ?? 50
  }));
}

function requireLimit<T>(value: T | null): T {
  if (value === null) throw new Error("Expected request to exceed a limit.");
  return value;
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
  const result = requireLimit(
    await limits.consumeRateLimit({ resource: "message_turn", userId: "u1", tenantId: "t1" })
  );
  expect(result.scope).toBe("user");
  expect(result.limitType).toBe("rate_limit");
});

test("consumeRateLimit rolls back counter when tenant limit is exceeded", async () => {
  const limits = makeConfig({ userRateLimit: 10, tenantRateLimit: 1 });
  const input = { resource: "message_turn" as const, userId: "u1", tenantId: "t1", now: 1_000 };
  expect(await limits.consumeRateLimit(input)).toBeNull();
  // Without rollback these retries consume the remaining user allowance.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    expect(requireLimit(await limits.consumeRateLimit(input)).scope).toBe("tenant");
  }
});

test("refundRateLimit releases a charge from both scopes", async () => {
  const limits = makeConfig({ userRateLimit: 2, tenantRateLimit: 2 });
  const input = { resource: "message_turn" as const, userId: "u1", tenantId: "t1" };

  await limits.consumeRateLimit(input);
  await limits.consumeRateLimit(input);
  await limits.refundRateLimit(input);

  expect(await limits.consumeRateLimit(input)).toBeNull();
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

test("resource_read reads its own limits and keeps one counter per user and one per tenant", async () => {
  const limits = RequestLimits.fromAppConfig(createTestConfig({
    RATE_LIMIT_WINDOW_MS: 60_000,
    RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW: 2,
    RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW: 3
  }));
  const read = (userId: string, tenantId: string, now: number) =>
    limits.consumeRateLimit({ resource: "resource_read", userId, tenantId, now });

  expect(await read("u1", "t1", 0)).toBeNull();
  expect(await read("u1", "t1", 0)).toBeNull();
  expect(await read("u1", "t1", 1_000)).toEqual({
    error: "limit_exceeded", limitType: "rate_limit", resource: "resource_read", scope: "user", limit: 2,
    retryAfterMs: 59_000, resetAt: new Date(60_000).toISOString(), message: "User resource read rate limit exceeded."
  });
  // A second member has a separate user counter, and shares the tenant counter.
  expect(await read("u2", "t1", 1_000)).toBeNull();
  expect(await read("u2", "t1", 1_000)).toMatchObject({ scope: "tenant", limit: 3 });
  expect(await read("u3", "t2", 1_000)).toBeNull();
  // Other resources keep their own counters.
  expect(await limits.consumeRateLimit({ resource: "artifact_upload", userId: "u1", tenantId: "t1", now: 1_000 }))
    .toBeNull();
  // The next window starts again from zero.
  expect(await read("u1", "t1", 60_000)).toBeNull();
});

test("a resource_read limit of 0 turns off only that scope", async () => {
  const input = { resource: "resource_read" as const, userId: "u1", tenantId: "t1" };
  const userOff = RequestLimits.fromAppConfig(createTestConfig({
    RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW: 0,
    RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW: 2
  }));
  expect(await userOff.consumeRateLimit(input)).toBeNull();
  expect(await userOff.consumeRateLimit(input)).toBeNull();
  expect(await userOff.consumeRateLimit(input)).toMatchObject({ scope: "tenant", limit: 2 });

  const bothOff = RequestLimits.fromAppConfig(createTestConfig({
    RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW: 0,
    RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW: 0
  }));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    expect(await bothOff.consumeRateLimit(input)).toBeNull();
  }
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
  const result = requireLimit(await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now }));
  expect(result.scope).toBe("user");
  expect(result.limitType).toBe("usage_quota");
});

test("consumeTurnQuota rolls back counter when tenant quota is exceeded", async () => {
  const limits = makeConfig({ userQuota: 10, tenantQuota: 1 });
  const now = new Date("2026-01-15T12:00:00.000Z");

  const first = await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now });
  expect(first).toBe(null);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    expect(requireLimit(await limits.consumeTurnQuota({ userId: "u1", tenantId: "t1", now })).scope)
      .toBe("tenant");
  }
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
