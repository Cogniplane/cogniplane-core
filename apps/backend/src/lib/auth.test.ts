import Fastify from "fastify";
import { test, expect } from "vitest";

import { localDevAuth } from "./auth.js";
import { workosAuth } from "./auth-workos.js";
import { createTestConfig } from "../test-helpers/test-config.js";

// The non-loopback opt-in removes the network guard, so this shared-secret check
// is the only thing between a reachable port and full cross-tenant
// impersonation. Everything else in dev-headers mode trusts X-User-Id verbatim.
async function buildApp(overrides: Parameters<typeof createTestConfig>[0]) {
  const app = Fastify();
  app.addHook("onRequest", localDevAuth(createTestConfig(overrides)));
  app.get("/whoami", async (request) => request.auth);
  return app;
}

test.each(["dev-headers", "workos"])("%s exposes only exact liveness and readiness paths", async (mode) => {
  const app = Fastify();
  const config = createTestConfig({
    COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: true,
    DEV_HEADERS_AUTH_KEY: "dev-headers-shared-secret"
  });
  app.addHook("onRequest", mode === "workos"
    ? workosAuth(config, { async getRole() { throw new Error("probe must not query membership"); } })
    : localDevAuth(config));
  for (const path of ["/health", "/ready", "/ready/private", "/readyevil", "/health/private"]) {
    app.get(path, async () => ({ ok: true }));
  }
  try {
    for (const path of ["/health", "/ready"]) {
      expect((await app.inject(`${path}?probe=1`)).statusCode).toBe(200);
    }
    for (const path of ["/ready/private", "/readyevil", "/health/private"]) {
      expect((await app.inject(path)).statusCode).toBe(401);
    }
  } finally {
    await app.close();
  }
});

test("dev-headers without the non-loopback opt-in does not require a key", async () => {
  const app = await buildApp({});
  const res = await app.inject({
    method: "GET",
    url: "/whoami",
    headers: { "x-user-id": "u1", "x-tenant-id": "t1" }
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ userId: "u1", tenantId: "t1" });
});

test("with the opt-in, identity headers are rejected without the shared key", async () => {
  const app = await buildApp({
    COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: true,
    DEV_HEADERS_AUTH_KEY: "dev-headers-shared-secret"
  });

  const missing = await app.inject({
    method: "GET",
    url: "/whoami",
    headers: { "x-user-id": "attacker", "x-tenant-id": "victim-tenant" }
  });
  expect(missing.statusCode).toBe(401);

  const wrong = await app.inject({
    method: "GET",
    url: "/whoami",
    headers: {
      "x-user-id": "attacker",
      "x-tenant-id": "victim-tenant",
      "x-dev-auth-key": "dev-headers-shared-secreT"
    }
  });
  expect(wrong.statusCode).toBe(401);

  const ok = await app.inject({
    method: "GET",
    url: "/whoami",
    headers: {
      "x-user-id": "u1",
      "x-tenant-id": "t1",
      "x-dev-auth-key": "dev-headers-shared-secret"
    }
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ userId: "u1", tenantId: "t1" });
});

test("GET /downloads/:token skips header auth: the token is the credential", async () => {
  const app = await buildApp({
    COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: true,
    DEV_HEADERS_AUTH_KEY: "dev-headers-shared-secret"
  });
  app.get("/downloads/:token", async (request) => ({ auth: request.auth ?? null }));
  app.post("/downloads/:token", async () => ({ ok: true }));

  // <img> tags cannot send custom headers. No identity is set, so identity
  // headers without the key cannot reach the route either.
  const spoofed = await app.inject({
    method: "GET",
    url: "/downloads/tok123",
    headers: { "x-user-id": "attacker", "x-tenant-id": "victim-tenant" }
  });
  expect(spoofed.statusCode).toBe(200);
  expect(spoofed.json()).toEqual({ auth: null });

  // Non-GET and nested paths stay gated.
  expect((await app.inject({ method: "POST", url: "/downloads/tok123" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/downloads/tok123/x" })).statusCode).toBe(401);
});

test.each(["/health", "/ready"])("%s stays reachable without the shared key", async (path) => {
  const app = await buildApp({
    COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: true,
    DEV_HEADERS_AUTH_KEY: "dev-headers-shared-secret"
  });
  app.get(path, async () => ({ ok: true }));

  const res = await app.inject({ method: "GET", url: `${path}?probe=1` });
  expect(res.statusCode).toBe(200);
});

// Ordinary local dev never sets a key, and the admin workbench depends on that
// identity being admin.
test("ordinary local dev keeps its admin identity", async () => {
  const app = await buildApp({});

  const res = await app.inject({ method: "GET", url: "/whoami" });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ userId: "test-user", isAdmin: true, role: "owner" });
});
