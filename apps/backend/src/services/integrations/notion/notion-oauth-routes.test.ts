import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { LimitExceededErrorPayload, RequestLimitsInterface } from "../../request-limits.js";
import { createTestConfig } from "../../../test-helpers/test-config.js";
import { registerNotionOAuthRoutes } from "./notion-oauth-routes.js";

const CONFIG = createTestConfig({ API_ORIGIN: "https://app.example.com" });
const BINDING_COOKIE = "cogniplane_oauth_bind_notion";

const throttled: LimitExceededErrorPayload = {
  error: "limit_exceeded", limitType: "rate_limit", resource: "oauth_callback", scope: "user", limit: 10,
  retryAfterMs: 1500, resetAt: "2026-10-03T00:00:02.000Z", message: "Too many requests."
};

function limitsReturning(result: () => Promise<LimitExceededErrorPayload | null>): RequestLimitsInterface {
  return {
    consumeRateLimit: vi.fn(result),
    consumeTurnQuota: async () => null,
    sweepExpired() {}
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function buildApp(limits?: RequestLimitsInterface) {
  const completeAuthorization = vi.fn(async () => "https://app.example.com/settings/notion?notionAuth=connected");
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.decorate("config", CONFIG);
  registerNotionOAuthRoutes(app, { completeAuthorization }, limits);
  return { app, completeAuthorization };
}

describe("GET /integrations/notion/callback", () => {
  test("completes the connection with the code, state, and browser nonce, then clears the nonce", async () => {
    const { app, completeAuthorization } = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/integrations/notion/callback?code=code-1&state=state-1",
      cookies: { [BINDING_COOKIE]: "nonce-1" }
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://app.example.com/settings/notion?notionAuth=connected");
    expect(completeAuthorization).toHaveBeenCalledWith({ code: "code-1", state: "state-1", browserNonce: "nonce-1" });
    const cleared = response.cookies.find((entry) => entry.name === BINDING_COOKIE);
    expect(cleared).toMatchObject({ value: "", path: "/integrations/notion/callback" });
  });

  test("passes null for a missing code, state, or nonce, so the service can refuse it", async () => {
    const { app, completeAuthorization } = await buildApp();

    await app.inject({ method: "GET", url: "/integrations/notion/callback" });

    expect(completeAuthorization).toHaveBeenCalledWith({ code: null, state: null, browserNonce: null });
  });

  test.each([
    ["access_denied", "access_denied"],
    ["server_error", "provider_unavailable"],
    ["temporarily_unavailable", "provider_unavailable"],
    ["invalid_scope", "provider_error"]
  ])("returns a provider error %s to the settings page as %s, without completing", async (error, reason) => {
    const { app, completeAuthorization } = await buildApp();

    const response = await app.inject({ method: "GET", url: `/integrations/notion/callback?error=${error}&code=code-1&state=state-1` });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe("https://app.example.com/settings/notion");
    expect(Object.fromEntries(location.searchParams)).toEqual({ notionAuth: "error", reason });
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  test("throttles by client IP before any state check", async () => {
    const limits = limitsReturning(async () => throttled);
    const { app, completeAuthorization } = await buildApp(limits);

    const response = await app.inject({ method: "GET", url: "/integrations/notion/callback?code=code-1&state=state-1", remoteAddress: "203.0.113.7" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toEqual(throttled);
    expect(limits.consumeRateLimit).toHaveBeenCalledWith({ resource: "oauth_callback", userId: "203.0.113.7", tenantId: "203.0.113.7" });
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  test("still completes when the rate limiter itself fails", async () => {
    const { app, completeAuthorization } = await buildApp(limitsReturning(async () => { throw new Error("redis down"); }));

    const response = await app.inject({ method: "GET", url: "/integrations/notion/callback?code=code-1&state=state-1" });

    expect(response.statusCode).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });
});
