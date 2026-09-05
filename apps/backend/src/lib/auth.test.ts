import Fastify from "fastify";
import { test, expect } from "vitest";

import { localDevAuth } from "./auth.js";
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

test("GET /downloads/:token works without the key, but identity headers are ignored", async () => {
  const app = await buildApp({
    COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: true,
    DEV_HEADERS_AUTH_KEY: "dev-headers-shared-secret"
  });
  app.get("/downloads/:token", async (request) => request.auth);

  // <img> tags cannot send custom headers; the download token is the credential.
  const headerless = await app.inject({ method: "GET", url: "/downloads/tok123" });
  expect(headerless.statusCode).toBe(200);
  expect(headerless.json()).toMatchObject({ userId: "test-user", tenantId: "local-dev-tenant" });

  // Identity headers without the key must not be trusted on the exempted path.
  const spoofed = await app.inject({
    method: "GET",
    url: "/downloads/tok123",
    headers: { "x-user-id": "attacker", "x-tenant-id": "victim-tenant" }
  });
  expect(spoofed.statusCode).toBe(200);
  expect(spoofed.json()).toMatchObject({ userId: "test-user", tenantId: "local-dev-tenant" });

  // Non-GET and non-download paths stay gated.
  const post = await app.inject({ method: "POST", url: "/downloads/tok123" });
  expect(post.statusCode).toBe(401);
});

test("/health stays reachable without the shared key (container probes)", async () => {
  const app = await buildApp({
    COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: true,
    DEV_HEADERS_AUTH_KEY: "dev-headers-shared-secret"
  });
  app.get("/health", async () => ({ ok: true }));

  const res = await app.inject({ method: "GET", url: "/health?probe=1" });
  expect(res.statusCode).toBe(200);
});

// GET /downloads/:token is let through without the shared key, because <img>
// tags cannot send custom headers. That request carries no identity headers, so
// it lands on LOCAL_DEV_USER_ID — which ADMIN_USER_IDS contains by default.
// Without the demotion, an unauthenticated caller would arrive holding the
// admin bypass on the download token's user_id check.
test("the /downloads/ fallback identity is never privileged", async () => {
  const app = await buildApp({
    COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: true,
    DEV_HEADERS_AUTH_KEY: "dev-headers-shared-secret"
  });
  app.get("/downloads/:token", async (request) => request.auth);

  const res = await app.inject({ method: "GET", url: "/downloads/tok-1" });

  expect(res.statusCode).toBe(200);
  // Both fields matter: routes/artifacts.ts gates the bypass on `role`, so
  // dropping only `isAdmin` would leave the hole open.
  expect(res.json()).toMatchObject({ isAdmin: false, role: "member" });
});

// The demotion is scoped to the stripped-header case. Ordinary local dev never
// sets a key, and the admin workbench depends on that identity being admin.
test("ordinary local dev keeps its admin identity", async () => {
  const app = await buildApp({});

  const res = await app.inject({ method: "GET", url: "/whoami" });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ userId: "test-user", isAdmin: true, role: "owner" });
});
