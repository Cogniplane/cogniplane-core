import Fastify from "fastify";
import { SignJWT } from "jose";
import { describe, test, expect, vi } from "vitest";

import { workosAuth } from "./auth-workos.js";
import { getJwtSigningKey, signAccessToken, signRefreshToken } from "./jwt.js";
import { runtimeTokenSecret } from "./derived-secrets.js";
import { generateRuntimeToken, runtimeTokenExpiry } from "../services/auth/runtime-token.js";
import type { TenantMembershipRole } from "../services/tenant-member-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";

// Browser navigations and <img> requests cannot send the Bearer header. In
// WorkOS mode they must still reach GET /downloads/:token, where the
// single-use token is the credential.
test("WorkOS auth lets GET /downloads/:token through without a Bearer header", async () => {
  const app = Fastify();
  app.addHook("onRequest", workosAuth(createTestConfig({}), { getRole: async () => null }, []));
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
describe("WorkOS auth with a Bearer access token", () => {
  const config = createTestConfig({});
  // Two tenants, so a lookup with the wrong tenant or user is caught.
  const roles: Record<string, TenantMembershipRole> = {
    "tenant-A/user-1": "member",
    "tenant-A/user-2": "owner",
    "tenant-B/user-1": "admin"
  };
  const getRole = vi.fn(async (tenantId: string, userId: string) => roles[`${tenantId}/${userId}`] ?? null);

  async function call(authorization: string | undefined, url = "/artifacts") {
    getRole.mockClear();
    const app = Fastify();
    app.addHook("onRequest", workosAuth(config, { getRole }, []));
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

  const bearer = async (sub: string, tid: string, claimedRole: TenantMembershipRole = "member") =>
    `Bearer ${await signAccessToken(config, { sub, tid, role: claimedRole, email: `${sub}@example.com` })}`;

  test.each([
    ["user-1", "tenant-A", "member", false],
    ["user-2", "tenant-A", "owner", true],
    ["user-1", "tenant-B", "admin", true]
  ] as const)("admits %s of %s with the stored role %s", async (sub, tid, role, isAdmin) => {
    const response = await call(await bearer(sub, tid));

    expect(response.statusCode).toBe(200);
    expect(response.json().auth).toEqual({ userId: sub, tenantId: tid, email: `${sub}@example.com`, role, isAdmin });
    // The role comes from the tenant membership, not from the token's own claim.
    expect(getRole).toHaveBeenCalledWith(tid, sub);
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
    expect(getRole).not.toHaveBeenCalled();
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
    expect(getRole).not.toHaveBeenCalled();
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
    expect(getRole).not.toHaveBeenCalled();
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
    expect(getRole).not.toHaveBeenCalled();
  });

  // A runtime token is a sandbox credential for the MCP gateway only.
  test("refuses a valid runtime token outside the MCP routes", async () => {
    const response = await call(`Bearer ${runtimeToken(60_000)}`);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_token" });
    expect(getRole).not.toHaveBeenCalled();
  });

  test("refuses an expired runtime token on an MCP route", async () => {
    const response = await call(`Bearer ${runtimeToken(-60_000)}`, "/mcp/notion");

    expect(response.statusCode).toBe(401);
    expect(response.json().auth).toBeUndefined();
    expect(getRole).not.toHaveBeenCalled();
  });
});
