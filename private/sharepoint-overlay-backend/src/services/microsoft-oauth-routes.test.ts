import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { LimitExceededErrorPayload } from "../../../../apps/backend/src/services/request-limits.js";
import { createTestConfig } from "../../../../apps/backend/src/test-helpers/test-config.js";
import { registerMicrosoftOAuthRoutes } from "./microsoft-oauth-routes.js";

const CONFIG = createTestConfig({ API_ORIGIN: "https://app.example.com" });

const throttled: LimitExceededErrorPayload = {
  error: "limit_exceeded", limitType: "rate_limit", resource: "oauth_callback", scope: "user", limit: 10,
  retryAfterMs: 1500, resetAt: "2026-10-03T00:00:02.000Z", message: "Too many requests."
};

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function buildApp(limits?: { consumeRateLimit: () => Promise<LimitExceededErrorPayload | null> }) {
  const completeAuthorization = vi.fn(async () => "https://app.example.com/settings/microsoft?microsoftAuth=connected");
  const app = Fastify();
  apps.push(app);
  // The overlay has no cookie plugin of its own; the host registers it.
  app.decorateReply("clearCookie", function () { return this; });
  app.decorate("config", CONFIG);
  registerMicrosoftOAuthRoutes(app, { completeAuthorization }, limits);
  return { app, completeAuthorization };
}

describe("GET /integrations/microsoft/callback", () => {
  test("redirects a provider error to the frontend origin without the provider's text", async () => {
    const { app, completeAuthorization } = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/integrations/microsoft/callback?error=access_denied&error_description=" +
        encodeURIComponent("<script>alert(1)</script> user cancelled")
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      "https://app.example.com/settings/microsoft?microsoftAuth=error&reason=access_denied"
    );
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  test("maps an unknown provider error to a fixed reason", async () => {
    const { app } = await buildApp();

    const response = await app.inject({ method: "GET", url: "/integrations/microsoft/callback?error=weird_thing" });

    expect(response.headers.location).toBe(
      "https://app.example.com/settings/microsoft?microsoftAuth=error&reason=provider_error"
    );
  });

  test("throttles the callback before it verifies the state", async () => {
    const consumeRateLimit = vi.fn(async () => throttled);
    const { app, completeAuthorization } = await buildApp({ consumeRateLimit });

    const response = await app.inject({ method: "GET", url: "/integrations/microsoft/callback?code=c&state=s" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("2");
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
