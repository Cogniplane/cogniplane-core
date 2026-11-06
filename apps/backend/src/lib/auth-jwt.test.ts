import Fastify from "fastify";
import { SignJWT } from "jose";
import { describe, test, expect, vi } from "vitest";

import { jwtAuth, jwtPublicAuthPaths } from "./auth-jwt.js";
import { getJwtSigningKey, signAccessToken, signRefreshToken } from "./jwt.js";
import { runtimeTokenSecret } from "./derived-secrets.js";
import { generateRuntimeToken, runtimeTokenExpiry } from "../services/auth/runtime-token.js";
import type { TenantAuthState, TenantMembershipRole } from "../services/tenant-member-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";

const JWT_CONFIG = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["workos"] });

// Browser navigations and <img> requests cannot send the Bearer header. In
// jwt mode they must still reach GET /downloads/:token, where the
// single-use token is the credential.
test("jwt auth lets GET /downloads/:token through without a Bearer header", async () => {
  const app = Fastify();
  app.addHook("onRequest", jwtAuth(JWT_CONFIG, { getAuthState: async () => null }, []));
  app.get("/downloads/:token", async (request) => ({ auth: request.auth ?? null }));
  app.get("/artifacts", async () => ({ ok: true }));

  const download = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(download.statusCode).toBe(200);
  expect(download.json()).toEqual({ auth: null });

  expect((await app.inject({ method: "GET", url: "/artifacts" })).json()).toEqual({ error: "missing_token" });
  expect((await app.inject({ method: "POST", url: "/downloads/tok-1" })).statusCode).toBe(401);
});

// The Bearer path: a real access token, verified with the real key, then the
// tenant role decides membership and admin rights.
describe("jwt auth with a Bearer access token", () => {
  const config = JWT_CONFIG;
  // Two tenants, so a lookup with the wrong tenant or user is caught.
  const roles: Record<string, TenantMembershipRole> = {
    "tenant-A/user-1": "member",
    "tenant-A/user-2": "owner",
    "tenant-B/user-1": "admin"
  };
  // Per-test override of the stored login facts, for the login-type checks.
  let loginFacts: Partial<TenantAuthState> = { loginType: "workos", authSource: "workos" };
  const getAuthState = vi.fn(async (tenantId: string, userId: string): Promise<TenantAuthState | null> => {
    const role = roles[`${tenantId}/${userId}`];
    return role ? { role, loginType: "workos", authSource: "workos", localStatus: null, securityVersion: null, ...loginFacts } : null;
  });

  async function call(authorization: string | undefined, url = "/artifacts") {
    getAuthState.mockClear();
    const app = Fastify();
    app.addHook("onRequest", jwtAuth(config, { getAuthState }, []));
    app.get("/artifacts", async (request) => ({ auth: request.auth ?? null }));
    app.post("/mcp/:server", async (request) => ({ auth: request.auth ?? null }));
    const response = await app.inject({
      method: url.startsWith("/mcp/") ? "POST" : "GET",
      url,
      headers: authorization ? { authorization } : {}
    });
    await app.close();
    return response;
  }

  const bearer = async (sub: string, tid: string, claimedRole: TenantMembershipRole = "member", extra: { sv?: number; fid?: string } = {}) =>
    `Bearer ${await signAccessToken(config, { sub, tid, role: claimedRole, email: `${sub}@example.com`, ...extra })}`;

  test.each([
    ["user-1", "tenant-A", "member", false],
    ["user-2", "tenant-A", "owner", true],
    ["user-1", "tenant-B", "admin", true]
  ] as const)("admits %s of %s with the stored role %s", async (sub, tid, role, isAdmin) => {
    const response = await call(await bearer(sub, tid));

    expect(response.statusCode).toBe(200);
    expect(response.json().auth).toEqual({
      userId: sub, tenantId: tid, email: `${sub}@example.com`, role, isAdmin,
      session: { authSource: "workos" }
    });
    // The role comes from the tenant membership, not from the token's own claim.
    expect(getAuthState).toHaveBeenCalledWith(tid, sub);
  });

  // The token's own role claim must never raise rights above the stored membership.
  test.each(["owner", "admin"] as const)("keeps a stored member a member when the token claims %s", async (claimed) => {
    const response = await call(await bearer("user-1", "tenant-A", claimed));

    expect(response.statusCode).toBe(200);
    expect(response.json().auth).toMatchObject({ role: "member", isAdmin: false });
  });

  test("refuses a token that claims owner for someone with no membership", async () => {
    const response = await call(await bearer("user-2", "tenant-B", "owner"));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not_a_member" });
  });

  test("refuses a refresh token used as an access token", async () => {
    const refresh = await signRefreshToken(config, { sub: "user-1", tid: "tenant-A", jti: "refresh-1", fid: "family-1" });

    const response = await call(`Bearer ${refresh}`);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_token" });
    expect(getAuthState).not.toHaveBeenCalled();
  });

  test("refuses a token for the refresh audience even when it carries access-token claims", async () => {
    // Only the audience check can reject this one: the claims are otherwise valid.
    const wrongAudience = await new SignJWT({ sub: "user-1", tid: "tenant-A", role: "member" })
      .setProtectedHeader({ alg: "HS256", kid: config.JWT_KEY_ID })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer("cogniplane")
      .setAudience("cogniplane-refresh")
      .sign(getJwtSigningKey(config));

    const response = await call(`Bearer ${wrongAudience}`);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_token" });
  });

  test("refuses a valid token for someone who is not a member of the tenant", async () => {
    const response = await call(await bearer("user-2", "tenant-B"));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not_a_member" });
  });

  test("refuses an expired token", async () => {
    const expired = await new SignJWT({ sub: "user-1", tid: "tenant-A", role: "member" })
      .setProtectedHeader({ alg: "HS256", kid: config.JWT_KEY_ID })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .setIssuer("cogniplane")
      .setAudience("cogniplane")
      .sign(getJwtSigningKey(config));

    const response = await call(`Bearer ${expired}`);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "token_expired" });
    expect(getAuthState).not.toHaveBeenCalled();
  });

  test.each([
    ["a malformed token", "Bearer not-a-jwt"],
    ["a token signed with another key", "other-key"]
  ])("refuses %s", async (_case, authorization) => {
    const header = authorization === "other-key"
      ? `Bearer ${await signAccessToken({ ...config, JWT_SECRET: "another-secret-that-is-at-least-32-chars" }, { sub: "user-1", tid: "tenant-A", role: "member" })}`
      : authorization;

    const response = await call(header);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_token" });
    expect(getAuthState).not.toHaveBeenCalled();
  });

  // Identity headers are a dev-headers feature. In jwt mode they carry no
  // weight, alone or next to a token for another user.
  test("ignores forged identity headers", async () => {
    getAuthState.mockClear();
    const app = Fastify();
    app.addHook("onRequest", jwtAuth(config, { getAuthState }, []));
    app.get("/artifacts", async (request) => ({ auth: request.auth ?? null }));
    const headers = { "x-user-id": "user-2", "x-tenant-id": "tenant-A" };

    const alone = await app.inject({ method: "GET", url: "/artifacts", headers });
    expect(alone.statusCode).toBe(401);
    expect(alone.json()).toEqual({ error: "missing_token" });

    const withToken = await app.inject({
      method: "GET",
      url: "/artifacts",
      headers: { ...headers, authorization: await bearer("user-1", "tenant-A") }
    });
    expect(withToken.json().auth).toMatchObject({ userId: "user-1", tenantId: "tenant-A", role: "member" });
    await app.close();
  });

  // See docs/ARCHITECTURE.md, "Authentication": a token acts only
  // when the user's login path is the tenant's login type, and that type is
  // enabled in this installation.
  test.each([
    ["the user's login path differs from the tenant's", { loginType: "workos", authSource: "local" }],
    ["the tenant's login type is not enabled", { loginType: "local", authSource: "local" }]
  ] as const)("refuses a member's token when %s", async (_case, facts) => {
    loginFacts = facts;
    try {
      const response = await call(await bearer("user-1", "tenant-A"));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "login_type_not_allowed" });
    } finally {
      loginFacts = { loginType: "workos", authSource: "workos" };
    }
  });

  // Local accounts: a session acts only while the account is active and the
  // token carries the account's current security version.
  describe("local accounts", () => {
    const localConfig = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["local"] });
    async function callLocal(authorization: string, facts: Partial<TenantAuthState>) {
      loginFacts = { loginType: "local", authSource: "local", localStatus: "active", securityVersion: 4, ...facts };
      const app = Fastify();
      app.addHook("onRequest", jwtAuth(localConfig, { getAuthState }, []));
      app.get("/artifacts", async (request) => ({ auth: request.auth ?? null }));
      try {
        return await app.inject({ method: "GET", url: "/artifacts", headers: { authorization } });
      } finally {
        loginFacts = { loginType: "workos", authSource: "workos" };
        await app.close();
      }
    }

    test("admits a token with the current security version and exposes the session", async () => {
      const response = await callLocal(await bearer("user-1", "tenant-A", "member", { sv: 4, fid: "family-1" }), {});
      expect(response.statusCode).toBe(200);
      expect(response.json().auth.session).toEqual({ familyId: "family-1", authSource: "local", securityVersion: 4 });
    });

    test.each([
      ["an older security version", { sv: 3 }, {}],
      ["no security version", {}, {}],
      ["a disabled account", { sv: 4 }, { localStatus: "disabled" as const }],
      ["an account not set up yet", { sv: 4 }, { localStatus: "pending_setup" as const }]
    ])("refuses a token with %s", async (_case, claims, facts) => {
      const response = await callLocal(await bearer("user-1", "tenant-A", "member", claims), facts);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "session_revoked" });
    });
  });

  const runtimeToken = (ttlMs: number) => generateRuntimeToken(
    { sid: "session-1", tid: "tenant-A", uid: "user-1", rid: "runtime-1", exp: runtimeTokenExpiry(ttlMs) },
    runtimeTokenSecret(config.DATA_ENCRYPTION_SECRET)
  );

  test("lets a runtime token through on MCP routes without a tenant lookup", async () => {
    const token = runtimeToken(60_000);

    const response = await call(`Bearer ${token}`, "/mcp/notion");

    expect(response.statusCode).toBe(200);
    expect(response.json().auth).toEqual({ userId: "user-1", tenantId: "tenant-A", isAdmin: false, role: "member" });
    expect(getAuthState).not.toHaveBeenCalled();
  });

  // A runtime token is a sandbox credential for the MCP gateway only.
  test("refuses a valid runtime token outside the MCP routes", async () => {
    const response = await call(`Bearer ${runtimeToken(60_000)}`);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_token" });
    expect(getAuthState).not.toHaveBeenCalled();
  });

  test("refuses an expired runtime token on an MCP route", async () => {
    const response = await call(`Bearer ${runtimeToken(-60_000)}`, "/mcp/notion");

    expect(response.statusCode).toBe(401);
    expect(response.json().auth).toBeUndefined();
    expect(getAuthState).not.toHaveBeenCalled();
  });
});

// The WorkOS sign-in routes are public only while WorkOS login is enabled.
// Refresh and logout are public in every jwt configuration.
test("public auth paths follow the enabled login types", async () => {
  const withoutWorkos = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: [] });
  for (const [config, loginStatus] of [[JWT_CONFIG, 200], [withoutWorkos, 401]] as const) {
    const app = Fastify();
    app.addHook("onRequest", jwtAuth(config, { getAuthState: async () => null }, []));
    for (const path of ["/auth/login", "/auth/refresh"]) app.get(path, async () => ({ ok: true }));
    expect((await app.inject("/auth/login")).statusCode).toBe(loginStatus);
    expect((await app.inject("/auth/refresh")).statusCode).toBe(200);
    await app.close();
  }
});

// Passkey ceremonies are public only with local login and an RP id.
test("public passkey paths need WEBAUTHN_RP_ID", () => {
  const local = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["local"] });
  expect(jwtPublicAuthPaths(local, []).has("/auth/passkey/login/verify")).toBe(false);
  const withPasskeys = jwtPublicAuthPaths({ ...local, WEBAUTHN_RP_ID: "app.example.test" }, []);
  for (const path of ["/auth/passkey/login/options", "/auth/passkey/login/verify", "/auth/local/mfa/passkey/verify", "/auth/local/enroll/passkey/verify"]) {
    expect(withPasskeys.has(path)).toBe(true);
  }
  // Signed-in passkey routes are never public.
  expect(withPasskeys.has("/auth/step-up/passkey")).toBe(false);
  expect(withPasskeys.has("/me/security/passkeys/options")).toBe(false);
});

// "Forgot password" is public only with local login and email.
test("the public forgot-password path needs SMTP_URL and MAIL_FROM", () => {
  const local = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["local"] });
  expect(jwtPublicAuthPaths(local, []).has("/auth/local/password/forgot")).toBe(false);
  const mail = { SMTP_URL: "smtps://smtp.example.test", MAIL_FROM: "no-reply@example.test" };
  expect(jwtPublicAuthPaths({ ...local, ...mail }, []).has("/auth/local/password/forgot")).toBe(true);
  const workos = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["workos"], ...mail });
  expect(jwtPublicAuthPaths(workos, []).has("/auth/local/password/forgot")).toBe(false);
});
