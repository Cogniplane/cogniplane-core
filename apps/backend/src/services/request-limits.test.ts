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

// Issue #47: the auth limits have one subject per request (the client IP, or
// the verified refresh family) and no tenant scope.
test("auth limits read their own settings and count one subject each", async () => {
  const limits = RequestLimits.fromAppConfig(createTestConfig({
    RATE_LIMIT_WINDOW_MS: 60_000,
    AUTH_SIGN_IN_LIMIT_PER_IP_PER_WINDOW: 2,
    AUTH_REFRESH_LIMIT_PER_FAMILY_PER_WINDOW: 3,
    OAUTH_CALLBACK_LIMIT_PER_USER_PER_WINDOW: 1
  }));
  const signIn = { resource: "auth_sign_in" as const, userId: "198.51.100.1", tenantId: "198.51.100.1" };
  const family = (id: string) => ({ resource: "auth_refresh" as const, userId: `family:${id}`, tenantId: `family:${id}` });

  expect(await limits.consumeRateLimit(signIn)).toBeNull();
  expect(await limits.consumeRateLimit(signIn)).toBeNull();
  expect(await limits.consumeRateLimit(signIn)).toMatchObject({ resource: "auth_sign_in", scope: "user", limit: 2, message: "User sign-in rate limit exceeded." });
  for (let i = 0; i < 3; i += 1) expect(await limits.consumeRateLimit(family("a"))).toBeNull();
  expect(await limits.consumeRateLimit(family("a"))).toMatchObject({ resource: "auth_refresh", scope: "user", limit: 3, message: "User refresh and sign-out rate limit exceeded." });
  expect(await limits.consumeRateLimit(family("b"))).toBeNull();
});
