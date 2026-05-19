import { test, expect, describe, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { registerAuthRoutes, resolveTenantMembershipRole, timingSafeEqualString } from "./auth.js";
import { signRefreshToken } from "../lib/jwt.js";
import { issueRefreshJti } from "../lib/refresh-token-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import { createFakeWorkOS, type FakeWorkOSHandlers } from "../test-helpers/fake-workos.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";

// ──────────────────────────────────────────────────────────────────────────
// Pure-helper coverage (kept from the original auth.test.ts).
// ──────────────────────────────────────────────────────────────────────────

test("resolveTenantMembershipRole preserves an existing owner role", () => {
  expect(resolveTenantMembershipRole({
          existingRole: "owner",
          isFirstMember: false,
          workosRoleSlug: "member"
        })).toBe("owner");
});

test("resolveTenantMembershipRole syncs non-owner roles from WorkOS", () => {
  expect(resolveTenantMembershipRole({
          existingRole: "admin",
          isFirstMember: false,
          workosRoleSlug: "member"
        })).toBe("member");

  expect(resolveTenantMembershipRole({
          existingRole: "member",
          isFirstMember: false,
          workosRoleSlug: "admin"
        })).toBe("admin");
});

test("resolveTenantMembershipRole derives the initial role for new memberships", () => {
  expect(resolveTenantMembershipRole({
          existingRole: null,
          isFirstMember: true,
          workosRoleSlug: "member"
        })).toBe("owner");

  expect(resolveTenantMembershipRole({
          existingRole: null,
          isFirstMember: false,
          workosRoleSlug: "admin"
        })).toBe("admin");

  expect(resolveTenantMembershipRole({
          existingRole: null,
          isFirstMember: false,
          workosRoleSlug: "member"
        })).toBe("member");
});

test("resolveTenantMembershipRole defaults to member when WorkOS slug is null/undefined", () => {
  expect(
    resolveTenantMembershipRole({
      existingRole: null,
      isFirstMember: false,
      workosRoleSlug: null
    })
  ).toBe("member");
  expect(
    resolveTenantMembershipRole({
      existingRole: null,
      isFirstMember: false,
      workosRoleSlug: undefined
    })
  ).toBe("member");
});

describe("timingSafeEqualString", () => {
  test("returns true for identical strings", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
  });

  test("returns true for empty strings on both sides", () => {
    expect(timingSafeEqualString("", "")).toBe(true);
  });

  test("returns false (without throwing) for strings of different length", () => {
    // crypto.timingSafeEqual would throw on different-length buffers; the
    // wrapper must short-circuit cleanly.
    expect(timingSafeEqualString("abc", "abcd")).toBe(false);
    expect(timingSafeEqualString("", "x")).toBe(false);
  });

  test("returns false for strings of equal length but different content", () => {
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Route coverage. Each route group builds its own app so cookie/Redis state
// stays isolated between tests.
// ──────────────────────────────────────────────────────────────────────────

const TEST_CONFIG = createTestConfig({
  AUTH_MODE: "workos",
  WORKOS_API_KEY: "test-workos-api-key",
  WORKOS_CLIENT_ID: "test-client-id",
  WORKOS_REDIRECT_URI: "https://test.example/auth/callback"
});

type Harness = {
  app: FastifyInstance;
  pool: FakePool;
  redis: FakeRefreshTokenRedis;
  workosMocks: FakeWorkOSHandlers;
  auditEvents: InMemoryAuditEventStore;
};

async function buildHarness(opts: {
  authPreHandler?: (request: { auth?: { userId: string; tenantId: string; isAdmin: boolean; role: "owner" | "admin" | "member" } & { email?: string } }) => void;
} = {}): Promise<Harness> {
  const pool = new FakePool();
  const redis = new FakeRefreshTokenRedis();
  const { workos, mocks } = createFakeWorkOS();
  const auditEvents = new InMemoryAuditEventStore();

  const app = Fastify();
  app.decorate("redis", redis.asAppRedis());
  await app.register(cookie);

  // Tests that hit auth-protected routes (/auth/me, /auth/organizations)
  // need `request.auth` populated. We don't run the real `workosAuth`
  // middleware here — the auth route file doesn't ship middleware itself,
  // and we want to exercise the handler logic, not re-test JWT decode.
  if (opts.authPreHandler) {
    app.addHook("preHandler", async (request) => {
      opts.authPreHandler!(request as never);
    });
  }

  await registerAuthRoutes(app, {
    db: pool.asPool(),
    config: TEST_CONFIG,
    auditEvents: auditEvents as never,
    workos
  });

  return { app, pool, redis, workosMocks: mocks, auditEvents };
}

function parseSetCookie(header: string | string[] | undefined, name: string): {
  value: string;
  attrs: Record<string, string | true>;
} | null {
  if (!header) return null;
  const headers = Array.isArray(header) ? header : [header];
  for (const raw of headers) {
    const [first, ...rest] = raw.split(";");
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq === -1) continue;
    const cookieName = first.slice(0, eq).trim();
    if (cookieName !== name) continue;
    const value = first.slice(eq + 1).trim();
    const attrs: Record<string, string | true> = {};
    for (const part of rest) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) {
        attrs[trimmed.toLowerCase()] = true;
      } else {
        attrs[trimmed.slice(0, idx).toLowerCase()] = trimmed.slice(idx + 1).trim();
      }
    }
    return { value, attrs };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// /auth/login
// ──────────────────────────────────────────────────────────────────────────

describe("GET /auth/login", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await buildHarness();
    harness.workosMocks.getAuthorizationUrl.mockReturnValue(
      "https://api.workos.com/auth/authorize?state=stub"
    );
  });

  test("returns the authorization URL and sets the OAuth state cookie", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://api.workos.com/auth/authorize?state=stub" });

    const stateCookie = parseSetCookie(res.headers["set-cookie"], "cogniplane_oauth_state");
    expect(stateCookie).not.toBeNull();
    // The base64url-encoded random state is 43 chars (32 bytes → ~43 b64url chars).
    expect(stateCookie!.value.length).toBeGreaterThan(20);
    expect(stateCookie!.attrs.httponly).toBe(true);
    expect(stateCookie!.attrs.secure).toBe(true);
    expect(String(stateCookie!.attrs.samesite).toLowerCase()).toBe("none");
    expect(stateCookie!.attrs.path).toBe("/");
  });

  test("rejects a malformed organization parameter (400)", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/auth/login?organization=%21not%20allowed%21"
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_oauth_param", field: "organization" });
  });

  test("rejects a malformed connection parameter (400)", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/auth/login?connection=has%20space"
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_oauth_param", field: "connection" });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /auth/callback
// ──────────────────────────────────────────────────────────────────────────

describe("POST /auth/callback", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  function seedWorkOSHappyPath(opts: {
    userId?: string;
    organizationId?: string;
    workosRoleSlug?: string;
  } = {}) {
    const userId = opts.userId ?? "workos-user-123";
    const organizationId = opts.organizationId ?? "org_456";
    harness.workosMocks.authenticateWithCode.mockResolvedValue({
      user: { id: userId, email: "alice@example.com", firstName: "Alice", lastName: "Smith" },
      organizationId
    });
    harness.workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId,
          role: { slug: opts.workosRoleSlug ?? "member" }
        }
      ]
    });
    harness.workosMocks.getOrganization.mockResolvedValue({
      id: organizationId,
      name: "Acme Inc"
    });
  }

  test("rejects missing code (400)", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { state: "x" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "missing_code" });
  });

  test("rejects when state cookie is absent (400)", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "abc" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_state" });
  });

  test("rejects when state in body does not match the cookie (400) and clears the cookie", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "alpha" },
      cookies: { cogniplane_oauth_state: "beta" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_state" });
    const cleared = parseSetCookie(res.headers["set-cookie"], "cogniplane_oauth_state");
    // Cookie clear emits Expires in the past / Max-Age=0.
    expect(cleared?.attrs["max-age"] ?? cleared?.attrs.expires).toBeDefined();
  });

  test("first member of a tenant is promoted to owner; refresh JTI is issued; refresh cookie is scoped SameSite=None Secure HttpOnly Path=/", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    // DB choreography: every multi-statement upsert returns the expected row.
    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({
        rows: [{ tenant_id: "tenant-uuid-1" }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO users/, () => ({
        rows: [{ user_id: "user-uuid-1" }],
        rowCount: 1
      }))
      .onQuery(/COUNT\(\*\) AS cnt FROM tenant_memberships/, () => ({
        // 0 = first member → owner promotion
        rows: [{ cnt: "0" }],
        rowCount: 1
      }))
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({
        // No existing membership → previousRole undefined → no role_changed audit
        rows: [],
        rowCount: 0
      }))
      .onQuery(/INSERT INTO tenant_memberships/, () => ({ rows: [], rowCount: 1 }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "valid-code", state: "the-state" },
      cookies: { cogniplane_oauth_state: "the-state" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; user: { role: string; userId: string; tenantId: string } };
    expect(body.user.role).toBe("owner");
    expect(body.user.userId).toBe("user-uuid-1");
    expect(body.user.tenantId).toBe("tenant-uuid-1");
    expect(body.accessToken.length).toBeGreaterThan(0);

    // Refresh cookie scoping — this is the security-critical claim from CLAUDE.md.
    const refresh = parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh");
    expect(refresh).not.toBeNull();
    expect(refresh!.attrs.httponly).toBe(true);
    expect(refresh!.attrs.secure).toBe(true);
    expect(String(refresh!.attrs.samesite).toLowerCase()).toBe("none");
    expect(refresh!.attrs.path).toBe("/");

    // JTI was issued in Redis — exactly one refresh_jti:* and one refresh_family:* key.
    const jtiKeys = [...harness.redis.store.keys()].filter((k) => k.startsWith("refresh_jti:"));
    const familyKeys = [...harness.redis.store.keys()].filter((k) => k.startsWith("refresh_family:"));
    expect(jtiKeys).toHaveLength(1);
    expect(familyKeys).toHaveLength(1);
    expect(harness.redis.store.get(familyKeys[0]!)).toBe("active");

    // No role_changed audit because previousRole was undefined.
    expect(harness.auditEvents.events.filter((e) => e.type === "role_changed")).toHaveLength(0);
  });

  test("existing owner keeps owner role even if WorkOS sends a downgraded slug — no role_changed audit", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\) AS cnt/, () => ({ rows: [{ cnt: "5" }], rowCount: 1 }))
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({
        rows: [{ role: "owner" }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO tenant_memberships/, () => ({ rows: [], rowCount: 1 }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s" }
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { role: string } }).user.role).toBe("owner");
    expect(harness.auditEvents.events.filter((e) => e.type === "role_changed")).toHaveLength(0);
  });

  test("role change from member to admin emits a role_changed audit event with from/to payload", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "admin" });

    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\) AS cnt/, () => ({ rows: [{ cnt: "5" }], rowCount: 1 }))
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({
        rows: [{ role: "member" }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO tenant_memberships/, () => ({ rows: [], rowCount: 1 }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s" }
    });

    expect(res.statusCode).toBe(200);
    const audits = harness.auditEvents.events.filter((e) => e.type === "role_changed");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toEqual({ from: "member", to: "admin" });
    expect(audits[0]!.userId).toBe("u1");
  });

  test("rejects when no organization membership exists (403)", async () => {
    harness.workosMocks.authenticateWithCode.mockResolvedValue({
      user: { id: "u-no-org", email: "x@y.z", firstName: "X", lastName: "Y" },
      organizationId: null
    });
    harness.workosMocks.listOrganizationMemberships.mockResolvedValue({ data: [] });

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s" }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "no_organization" });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /auth/refresh — the security-critical surface (jti rotation + replay).
// ──────────────────────────────────────────────────────────────────────────

describe("POST /auth/refresh", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await buildHarness();
  });

  test("rejects when the refresh cookie is missing (401)", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/auth/refresh" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "missing_refresh_token" });
  });

  test("valid refresh: rotates jti, issues new access + cookie, keeps family active", async () => {
    const familyId = "fid-1";
    const oldJti = "jti-old";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-1",
      tid: "tenant-1",
      jti: oldJti,
      fid: familyId
    });
    await issueRefreshJti(harness.redis, { jti: oldJti, familyId, ttlSeconds: 60 });

    harness.pool
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({
        rows: [{ role: "admin" }],
        rowCount: 1
      }))
      .onQuery(/SELECT email FROM users/, () => ({
        rows: [{ email: "alice@example.com" }],
        rowCount: 1
      }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { accessToken: string }).accessToken.length).toBeGreaterThan(0);

    // Old jti consumed.
    expect(harness.redis.store.has(`refresh_jti:${oldJti}`)).toBe(false);
    // New jti issued, same family, still active.
    const newJtiKeys = [...harness.redis.store.keys()].filter(
      (k) => k.startsWith("refresh_jti:") && k !== `refresh_jti:${oldJti}`
    );
    expect(newJtiKeys).toHaveLength(1);
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("active");

    // New refresh cookie set with the same scoping as the callback path.
    const cookieHeader = parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh");
    expect(cookieHeader).not.toBeNull();
    expect(cookieHeader!.attrs.httponly).toBe(true);
    expect(cookieHeader!.attrs.secure).toBe(true);
    expect(String(cookieHeader!.attrs.samesite).toLowerCase()).toBe("none");
  });

  test("replay of an already-consumed jti revokes the family, emits audit, clears cookie, returns 401", async () => {
    const familyId = "fid-replay";
    const jti = "jti-replayed";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-2",
      tid: "tenant-2",
      jti,
      fid: familyId
    });
    // Issue THEN consume — the second presentation of this jti is the replay.
    await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });
    await harness.redis.getdel(`refresh_jti:${jti}`);
    // Family still marked active until this request.
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("active");

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "token_revoked" });

    // Family flipped to revoked.
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("revoked");

    // Audit event recorded with the family id.
    const reuseAudits = harness.auditEvents.events.filter(
      (e) => e.type === "auth.refresh_token_reuse_detected"
    );
    expect(reuseAudits).toHaveLength(1);
    expect(reuseAudits[0]!.payload).toEqual({ familyId });
    expect(reuseAudits[0]!.userId).toBe("user-2");

    // Cookie cleared.
    const cleared = parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh");
    expect(cleared).not.toBeNull();
    expect(cleared!.attrs["max-age"] ?? cleared!.attrs.expires).toBeDefined();
  });

  test("refresh against a revoked family returns 401 without re-revoking", async () => {
    const familyId = "fid-already-revoked";
    const jti = "jti-x";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-3",
      tid: "tenant-3",
      jti,
      fid: familyId
    });
    await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });
    // Pre-revoke the family.
    harness.redis.store.set(`refresh_family:${familyId}`, "revoked");

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "token_revoked" });
    // No reuse-detected audit on an already-revoked family.
    expect(
      harness.auditEvents.events.filter((e) => e.type === "auth.refresh_token_reuse_detected")
    ).toHaveLength(0);
  });

  test("returns 403 when the user is no longer a tenant member", async () => {
    const familyId = "fid-no-member";
    const jti = "jti-no-member";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-4",
      tid: "tenant-4",
      jti,
      fid: familyId
    });
    await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });

    harness.pool.onQuery(/SELECT role FROM tenant_memberships/, () => ({
      rows: [],
      rowCount: 0
    }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not_a_member" });
  });

  test("rejects a malformed/invalid refresh token (401)", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: "not-a-real-jwt" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_refresh_token" });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /auth/logout
// ──────────────────────────────────────────────────────────────────────────

describe("POST /auth/logout", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await buildHarness();
  });

  test("revokes the family and clears the refresh cookie", async () => {
    const familyId = "fid-logout";
    const jti = "jti-logout";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-l",
      tid: "tenant-l",
      jti,
      fid: familyId
    });
    await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("revoked");
    const cleared = parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh");
    expect(cleared).not.toBeNull();
  });

  test("tolerates an absent refresh cookie (no Redis writes, 200)", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(harness.redis.store.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /auth/me
// ──────────────────────────────────────────────────────────────────────────

describe("GET /auth/me", () => {
  test("returns 401 when request.auth is missing", async () => {
    const harness = await buildHarness();
    const res = await harness.app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  test("returns 404 when the user row cannot be found", async () => {
    const harness = await buildHarness({
      authPreHandler: (request) => {
        request.auth = {
          userId: "missing-user",
          tenantId: "tenant-x",
          isAdmin: false,
          role: "member"
        };
      }
    });
    harness.pool.onQuery(/FROM users u/, () => ({ rows: [], rowCount: 0 }));

    const res = await harness.app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "user_not_found" });
  });

  test("returns the user, tenant, and role on success", async () => {
    const harness = await buildHarness({
      authPreHandler: (request) => {
        request.auth = {
          userId: "user-1",
          tenantId: "tenant-1",
          isAdmin: true,
          role: "admin"
        };
      }
    });
    harness.pool.onQuery(/FROM users u/, () => ({
      rows: [
        {
          user_id: "user-1",
          email: "alice@example.com",
          display_name: "Alice",
          tenant_id: "tenant-1",
          tenant_name: "Acme",
          slug: "acme",
          role: "admin"
        }
      ],
      rowCount: 1
    }));

    const res = await harness.app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: "user-1",
      email: "alice@example.com",
      displayName: "Alice",
      tenantId: "tenant-1",
      tenantName: "Acme",
      tenantSlug: "acme",
      role: "admin"
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /auth/organizations
// ──────────────────────────────────────────────────────────────────────────

describe("GET /auth/organizations", () => {
  test("returns 401 when request.auth is missing", async () => {
    const harness = await buildHarness();
    const res = await harness.app.inject({ method: "GET", url: "/auth/organizations" });
    expect(res.statusCode).toBe(401);
  });

  test("returns an empty list when the user has no workos_user_id", async () => {
    const harness = await buildHarness({
      authPreHandler: (request) => {
        request.auth = {
          userId: "u-no-workos",
          tenantId: "t",
          isAdmin: false,
          role: "member"
        };
      }
    });
    harness.pool.onQuery(/workos_user_id FROM users/, () => ({
      rows: [{ workos_user_id: null }],
      rowCount: 1
    }));

    const res = await harness.app.inject({ method: "GET", url: "/auth/organizations" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ organizations: [] });
    // WorkOS not called when no workos_user_id.
    expect(harness.workosMocks.listOrganizationMemberships).not.toHaveBeenCalled();
  });
});
