import { test, expect, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";

import { createTestConfig } from "../../test-helpers/test-config.js";
import { RequestLimits, type LimitExceededErrorPayload, type RequestLimitsInterface } from "../request-limits.js";
import { enforceOAuthCallbackRateLimit } from "./oauth-callback-rate-limit.js";

function fakeReply() {
  return {
    code: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis()
  } as unknown as FastifyReply & {
    code: ReturnType<typeof vi.fn>;
    header: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

const limitPayload: LimitExceededErrorPayload = {
  error: "limit_exceeded",
  limitType: "rate_limit",
  resource: "oauth_callback",
  scope: "user",
  limit: 20,
  retryAfterMs: 30_000,
  resetAt: new Date().toISOString(),
  message: "User OAuth callback rate limit exceeded."
};

test("a limiter outage lets OAuth state validation handle the redirect", async () => {
  const warn = vi.fn();
  const request = { ip: "203.0.113.1", log: { warn } } as unknown as FastifyRequest;
  const limits = { consumeRateLimit: async () => { throw new Error("Redis offline"); } } as unknown as RequestLimitsInterface;
  const reply = fakeReply();
  expect(await enforceOAuthCallbackRateLimit(request, reply, limits)).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
  expect(reply.send).not.toHaveBeenCalled();
});

test("allows the request and keys the limit on the client IP for both scopes", async () => {
  const consumeRateLimit = vi.fn(async () => null);
  const limits = { consumeRateLimit } as unknown as RequestLimitsInterface;
  const request = { ip: "203.0.113.5" } as FastifyRequest;
  const reply = fakeReply();

  const throttled = await enforceOAuthCallbackRateLimit(request, reply, limits);

  expect(throttled).toBe(false);
  expect(consumeRateLimit).toHaveBeenCalledWith({
    resource: "oauth_callback",
    userId: "203.0.113.5",
    tenantId: "203.0.113.5"
  });
  expect(reply.code).not.toHaveBeenCalled();
});

test("throttles with a 429 + Retry-After when the limit is exceeded", async () => {
  const limits = {
    consumeRateLimit: async () => limitPayload
  } as unknown as RequestLimitsInterface;
  const request = { ip: "203.0.113.9" } as FastifyRequest;
  const reply = fakeReply();

  const throttled = await enforceOAuthCallbackRateLimit(request, reply, limits);

  expect(throttled).toBe(true);
  expect(reply.code).toHaveBeenCalledWith(429);
  expect(reply.header).toHaveBeenCalledWith("retry-after", 30);
  expect(reply.send).toHaveBeenCalledWith(limitPayload);
});

test("falls back to a single 'unknown' bucket when no client IP is present", async () => {
  const consumeRateLimit = vi.fn(async () => null);
  const limits = { consumeRateLimit } as unknown as RequestLimitsInterface;
  const request = { ip: "" } as FastifyRequest;
  const reply = fakeReply();

  await enforceOAuthCallbackRateLimit(request, reply, limits);

  expect(consumeRateLimit).toHaveBeenCalledWith({
    resource: "oauth_callback",
    userId: "unknown",
    tenantId: "unknown"
  });
});

test("allows the request when no limiter is wired", async () => {
  const request = { ip: "203.0.113.1" } as FastifyRequest;
  const reply = fakeReply();

  const throttled = await enforceOAuthCallbackRateLimit(request, reply, undefined);

  expect(throttled).toBe(false);
  expect(reply.code).not.toHaveBeenCalled();
});

// Issue #47: a sign-in flood from one IP must not stop the integration
// callbacks of the people behind that IP, and the reverse.
test("integration callbacks and sign-in have separate per-IP buckets in the real limiter", async () => {
  const limits = RequestLimits.fromAppConfig(createTestConfig());
  const signIn = { resource: "auth_sign_in" as const, userId: "203.0.113.5", tenantId: "203.0.113.5" };
  let refusal = null;
  for (let attempt = 0; attempt < 100 && !refusal; attempt += 1) refusal = await limits.consumeRateLimit(signIn);
  expect(refusal).toMatchObject({ resource: "auth_sign_in" });

  const reply = fakeReply();
  const callback = await enforceOAuthCallbackRateLimit({ ip: "203.0.113.5" } as FastifyRequest, reply, limits);

  expect(callback).toBe(false);
  expect(reply.code).not.toHaveBeenCalled();
});
