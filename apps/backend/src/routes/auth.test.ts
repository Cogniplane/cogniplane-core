import { test, expect, describe, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { registerAuthRoutes, timingSafeEqualString } from "./auth.js";
import { resolveTenantMembershipRole } from "../services/auth/workos-tenant-provisioning.js";
import { signRefreshToken } from "../lib/jwt.js";
import { issueRefreshJti } from "../lib/refresh-token-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import { createFakeWorkOS, type FakeWorkOSHandlers } from "../test-helpers/fake-workos.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import type {
  LimitExceededErrorPayload,
  RequestLimitsInterface
} from "../services/request-limits.js";

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

// The tenant's own RBAC wins once a membership exists: WorkOS seeds the role at
// provisioning only. Re-syncing on every login would restore an admin the owner
// just demoted in-app, and reverse an in-app promotion.
test("resolveTenantMembershipRole never overwrites an existing role from WorkOS", () => {
  expect(resolveTenantMembershipRole({
          existingRole: "admin",
          isFirstMember: false,
          workosRoleSlug: "member"
        })).toBe("admin");

  expect(resolveTenantMembershipRole({
          existingRole: "member",
          isFirstMember: false,
          workosRoleSlug: "admin"
        })).toBe("member");
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
const TEST_PKCE_VERIFIER = "v".repeat(43);

type Harness = {
  app: FastifyInstance;
  pool: FakePool;
  redis: FakeRefreshTokenRedis;
  workosMocks: FakeWorkOSHandlers;
  auditEvents: InMemoryAuditEventStore;
};

async function buildHarness(opts: {
  authPreHandler?: (request: { auth?: { userId: string; tenantId: string; isAdmin: boolean; role: "owner" | "admin" | "member" } & { email?: string } }) => void;
  limits?: RequestLimitsInterface;
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
    limits: opts.limits,
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

const RATE_LIMIT_PAYLOAD: LimitExceededErrorPayload = {
  error: "limit_exceeded",
  limitType: "rate_limit",
  resource: "oauth_callback",
  scope: "user",
  limit: 20,
  retryAfterMs: 30_000,
  resetAt: "2026-06-10T00:00:00.000Z",
  message: "User OAuth callback rate limit exceeded."
};

function createThrottledLimits() {
  const consumeRateLimit = vi.fn(async () => RATE_LIMIT_PAYLOAD);
  return {
    consumeRateLimit,
    limits: { consumeRateLimit } as unknown as RequestLimitsInterface
  };
}

function expectRateLimited(res: { statusCode: number; headers: Record<string, unknown>; json(): unknown }) {
  expect(res.statusCode).toBe(429);
  expect(res.headers["retry-after"]).toBe("30");
  expect(res.json()).toEqual(RATE_LIMIT_PAYLOAD);
}

// ──────────────────────────────────────────────────────────────────────────
// /auth/login
// ──────────────────────────────────────────────────────────────────────────

describe("GET /auth/login", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await buildHarness();
    harness.workosMocks.getAuthorizationUrlWithPKCE.mockResolvedValue({
      url: "https://api.workos.com/auth/authorize?state=stub",
      state: "s".repeat(43),
      codeVerifier: TEST_PKCE_VERIFIER
    });
  });

  test("returns the authorization URL and sets the OAuth state cookie", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://api.workos.com/auth/authorize?state=stub" });

    const stateCookie = parseSetCookie(res.headers["set-cookie"], "cogniplane_oauth_state");
    expect(stateCookie).not.toBeNull();
    // WorkOS's PKCE helper generates a 43-character base64url state value.
    expect(stateCookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stateCookie!.attrs.httponly).toBe(true);
    expect(stateCookie!.attrs.secure).toBe(true);
    expect(String(stateCookie!.attrs.samesite).toLowerCase()).toBe("none");
    expect(stateCookie!.attrs.path).toBe("/");
    const pkceCookie = parseSetCookie(res.headers["set-cookie"], "cogniplane_oauth_pkce");
    expect(pkceCookie?.value).toBe(TEST_PKCE_VERIFIER);
    expect(pkceCookie?.attrs.httponly).toBe(true);
    expect(pkceCookie?.attrs.secure).toBe(true);
    expect(String(pkceCookie?.attrs.samesite).toLowerCase()).toBe("none");
    expect(pkceCookie?.attrs.path).toBe("/auth");
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

  test("rate-limits before minting state or calling WorkOS", async () => {
    const { limits, consumeRateLimit } = createThrottledLimits();
    const throttled = await buildHarness({ limits });

    const res = await throttled.app.inject({ method: "GET", url: "/auth/login" });

    expectRateLimited(res);
    expect(consumeRateLimit).toHaveBeenCalledWith({
      resource: "oauth_callback",
      userId: "127.0.0.1",
      tenantId: "127.0.0.1"
    });
    expect(throttled.workosMocks.getAuthorizationUrlWithPKCE).not.toHaveBeenCalled();
    expect(parseSetCookie(res.headers["set-cookie"], "cogniplane_oauth_state")).toBeNull();
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

  test("rate-limits before validating state or exchanging the code", async () => {
    const { limits } = createThrottledLimits();
    const throttled = await buildHarness({ limits });

    const res = await throttled.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "valid-code", state: "the-state" },
      cookies: {
        cogniplane_oauth_state: "the-state",
        cogniplane_oauth_pkce: TEST_PKCE_VERIFIER
      }
    });

    expectRateLimited(res);
    expect(throttled.workosMocks.authenticateWithCode).not.toHaveBeenCalled();
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
      cookies: {
        cogniplane_oauth_state: "beta",
        cogniplane_oauth_pkce: TEST_PKCE_VERIFIER
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_state" });
    const cleared = parseSetCookie(res.headers["set-cookie"], "cogniplane_oauth_state");
    // Cookie clear emits Expires in the past / Max-Age=0.
    expect(cleared?.attrs["max-age"] ?? cleared?.attrs.expires).toBeDefined();
    const clearedPkce = parseSetCookie(res.headers["set-cookie"], "cogniplane_oauth_pkce");
    expect(clearedPkce?.attrs["max-age"] ?? clearedPkce?.attrs.expires).toBeDefined();
  });

  test("rejects when the PKCE verifier cookie is absent", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s" }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_pkce_verifier" });
    expect(harness.workosMocks.authenticateWithCode).not.toHaveBeenCalled();
  });

  test("first member of a tenant is promoted to owner; refresh JTI is issued; refresh cookie is scoped to /auth", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    // DB choreography: every multi-statement upsert returns the expected row.
    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({
        rows: [{ tenant_id: "tenant-uuid-1" }],
        rowCount: 1
      }))
      // No row holds this email yet → the INSERT path.
      .onQuery(/SELECT user_id, workos_user_id FROM users WHERE email/, () => ({
        rows: [],
        rowCount: 0
      }))
      .onQuery(/INSERT INTO users/, () => ({
        rows: [{ user_id: "user-uuid-1" }],
        rowCount: 1
      }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({
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
      cookies: {
        cogniplane_oauth_state: "the-state",
        cogniplane_oauth_pkce: TEST_PKCE_VERIFIER
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; user: { role: string; userId: string; tenantId: string } };
    expect(body.user.role).toBe("owner");
    expect(body.user.userId).toBe("user-uuid-1");
    expect(body.user.tenantId).toBe("tenant-uuid-1");
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(harness.workosMocks.authenticateWithCode).toHaveBeenCalledWith({
      code: "valid-code",
      clientId: "test-client-id",
      codeVerifier: TEST_PKCE_VERIFIER
    });

    // Refresh cookie scoping — this is the security-critical claim from CLAUDE.md.
    const refresh = parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh");
    expect(refresh).not.toBeNull();
    expect(refresh!.attrs.httponly).toBe(true);
    expect(refresh!.attrs.secure).toBe(true);
    expect(String(refresh!.attrs.samesite).toLowerCase()).toBe("none");
    expect(refresh!.attrs.path).toBe("/auth");

    // JTI was issued in Redis — exactly one refresh_jti:* and one refresh_family:* key.
    const jtiKeys = [...harness.redis.store.keys()].filter((k) => k.startsWith("refresh_jti:"));
    const familyKeys = [...harness.redis.store.keys()].filter((k) => k.startsWith("refresh_family:"));
    expect(jtiKeys).toHaveLength(1);
    expect(familyKeys).toHaveLength(1);
    expect(harness.redis.store.get(familyKeys[0]!)).toBe("active");

    // No role_changed audit because previousRole was undefined.
    expect(harness.auditEvents.events.filter((e) => e.type === "role_changed")).toHaveLength(0);
  });

  // A WorkOS user deleted and re-created reuses the email under a NEW
  // workos_user_id. The users upsert can only name one conflict target, so
  // before this the INSERT hit the email unique constraint and 500'd a
  // legitimate login.
  test("a recycled WorkOS identity reusing an existing email logs in instead of 500ing", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    let insertAttempted = false;
    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ tenant_id: "t1" }], rowCount: 1 }))
      // The email is already held, by a row that was never bound to a WorkOS id.
      .onQuery(/SELECT user_id, workos_user_id FROM users WHERE email/, () => ({
        rows: [{ user_id: "existing-user", workos_user_id: null }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO users/, () => {
        insertAttempted = true;
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505"
        });
      })
      .onQuery(/UPDATE users/, () => ({ rows: [{ user_id: "existing-user" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({
        rows: [{ cnt: "5" }],
        rowCount: 1
      }))
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO tenant_memberships/, () => ({ rows: [], rowCount: 1 }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      cookies: {
        cogniplane_oauth_state: "the-state",
        cogniplane_oauth_pkce: TEST_PKCE_VERIFIER
      },
      payload: { code: "code-1", state: "the-state" }
    });

    expect(res.statusCode).toBe(200);
    // The existing row is rebound rather than re-inserted — an INSERT here
    // would collide on the email constraint the ON CONFLICT target misses.
    expect(insertAttempted).toBe(false);
  });

  // The other side of the same lookup: taking over an email that a DIFFERENT
  // live identity holds would hand one person another's account.
  test("an email held by a different WorkOS identity is refused with 409, not taken over", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    let membershipWritten = false;
    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id FROM users WHERE email/, () => ({
        rows: [{ user_id: "someone-else", workos_user_id: "workos-someone-else" }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO tenant_memberships/, () => {
        membershipWritten = true;
        return { rows: [], rowCount: 1 };
      });

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      cookies: {
        cogniplane_oauth_state: "the-state",
        cogniplane_oauth_pkce: TEST_PKCE_VERIFIER
      },
      payload: { code: "code-1", state: "the-state" }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "email_in_use" });
    // No session, and nothing granted against the other person's account.
    expect(membershipWritten).toBe(false);
    expect(parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh")).toBeNull();
  });

  // The owner renames the tenant through PUT /tenant; provisioning must not
  // undo that on the next member's login.
  test("provisioning does not overwrite tenant_name on an existing tenant", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    let tenantUpsertSql = "";
    harness.pool
      .onQuery(/INSERT INTO tenants/, (text) => {
        tenantUpsertSql = text;
        return { rows: [{ tenant_id: "t1" }], rowCount: 1 };
      })
      .onQuery(/SELECT user_id, workos_user_id FROM users WHERE email/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({
        rows: [{ cnt: "5" }],
        rowCount: 1
      }))
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({ rows: [{ role: "member" }], rowCount: 1 }))
      .onQuery(/INSERT INTO tenant_memberships/, () => ({ rows: [], rowCount: 1 }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      cookies: {
        cogniplane_oauth_state: "the-state",
        cogniplane_oauth_pkce: TEST_PKCE_VERIFIER
      },
      payload: { code: "code-1", state: "the-state" }
    });

    expect(res.statusCode).toBe(200);
    // The conflict clause must touch only updated_at.
    const doUpdateClause = tenantUpsertSql.slice(tenantUpsertSql.indexOf("DO UPDATE"));
    expect(doUpdateClause).not.toMatch(/tenant_name/);
  });

  test("existing owner keeps owner role even if WorkOS sends a downgraded slug — no role_changed audit", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id FROM users WHERE email/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({ rows: [{ cnt: "5" }], rowCount: 1 }))
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({
        rows: [{ role: "owner" }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO tenant_memberships/, () => ({ rows: [], rowCount: 1 }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s", cogniplane_oauth_pkce: TEST_PKCE_VERIFIER }
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { role: string } }).user.role).toBe("owner");
    expect(harness.auditEvents.events.filter((e) => e.type === "role_changed")).toHaveLength(0);
  });

  test("existing member is NOT re-promoted from the WorkOS slug — no role_changed audit", async () => {
    // The tenant's own RBAC is authoritative after provisioning. Re-syncing here
    // would restore an admin the owner just demoted in-app.
    seedWorkOSHappyPath({ workosRoleSlug: "admin" });

    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id FROM users WHERE email/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({ rows: [{ cnt: "5" }], rowCount: 1 }))
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({
        rows: [{ role: "member" }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO tenant_memberships/, () => ({ rows: [], rowCount: 1 }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s", cogniplane_oauth_pkce: TEST_PKCE_VERIFIER }
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { role: string } }).user.role).toBe("member");
    expect(harness.auditEvents.events.filter((e) => e.type === "role_changed")).toHaveLength(0);
    // The kept-vs-IdP mismatch is recorded instead of silently ignored.
    expect(harness.auditEvents.events.filter((e) => e.type === "role_sync_divergence")).toHaveLength(1);
  });

  test("existing admin demoted in WorkOS keeps the app role but emits role_sync_divergence", async () => {
    // App RBAC stays authoritative, so the IdP revocation does not propagate —
    // but it must leave an audit trace for the tenant owner to act on.
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id FROM users WHERE email/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({ rows: [{ cnt: "5" }], rowCount: 1 }))
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({
        rows: [{ role: "admin" }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO tenant_memberships/, () => ({ rows: [], rowCount: 1 }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s", cogniplane_oauth_pkce: TEST_PKCE_VERIFIER }
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { role: string } }).user.role).toBe("admin");
    const divergence = harness.auditEvents.events.filter((e) => e.type === "role_sync_divergence");
    expect(divergence).toHaveLength(1);
    expect(divergence[0].payload).toMatchObject({ appRole: "admin", workosRoleSlug: "member" });
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
      cookies: { cogniplane_oauth_state: "s", cogniplane_oauth_pkce: TEST_PKCE_VERIFIER }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "no_organization" });
  });

  test("requires explicit selection when the user belongs to multiple organizations", async () => {
    harness.workosMocks.authenticateWithCode.mockResolvedValue({
      user: { id: "u-multi", email: "multi@example.com", firstName: "Multi", lastName: "Org" },
      organizationId: null
    });
    harness.workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [
        { organizationId: "org_alpha", role: { slug: "member" } },
        { organizationId: "org_beta", role: { slug: "admin" } }
      ]
    });
    harness.workosMocks.getOrganization.mockImplementation(async (organizationId: string) => ({
      id: organizationId,
      name: organizationId === "org_alpha" ? "Alpha" : "Beta"
    }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s", cogniplane_oauth_pkce: TEST_PKCE_VERIFIER }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "organization_selection_required",
      organizations: [
        { id: "org_alpha", name: "Alpha" },
        { id: "org_beta", name: "Beta" }
      ]
    });
    expect(harness.pool.queries).toHaveLength(0);
  });

  test("rejects an organization hint that is not one of the user's memberships", async () => {
    harness.workosMocks.authenticateWithCode.mockResolvedValue({
      user: { id: "u-mismatch", email: "mismatch@example.com", firstName: "Mis", lastName: "Match" },
      organizationId: "org_unowned"
    });
    harness.workosMocks.listOrganizationMemberships.mockResolvedValue({
      data: [{ organizationId: "org_owned", role: { slug: "member" } }]
    });

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "c", state: "s" },
      cookies: { cogniplane_oauth_state: "s", cogniplane_oauth_pkce: TEST_PKCE_VERIFIER }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "no_organization" });
    expect(harness.workosMocks.getOrganization).not.toHaveBeenCalled();
    expect(harness.pool.queries).toHaveLength(0);
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

  test("rate-limits before reading or rotating the refresh token", async () => {
    const { limits } = createThrottledLimits();
    const throttled = await buildHarness({ limits });

    const res = await throttled.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: "not-a-real-jwt" }
    });

    expectRateLimited(res);
    expect(throttled.redis.store.size).toBe(0);
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
    expect(cookieHeader!.attrs.path).toBe("/auth");
  });

  test("concurrent refreshes return the same successor without revoking the family", async () => {
    const familyId = "fid-concurrent";
    const oldJti = "jti-concurrent";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-concurrent",
      tid: "tenant-concurrent",
      jti: oldJti,
      fid: familyId
    });
    await issueRefreshJti(harness.redis, { jti: oldJti, familyId, ttlSeconds: 60 });

    harness.pool
      .onQuery(/SELECT role FROM tenant_memberships/, () => ({
        rows: [{ role: "member" }],
        rowCount: 1
      }))
      .onQuery(/SELECT email FROM users/, () => ({
        rows: [{ email: "concurrent@example.com" }],
        rowCount: 1
      }));

    const request = () =>
      harness.app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { cogniplane_refresh: refreshToken }
      });
    const [first, second] = await Promise.all([request(), request()]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
    expect(parseSetCookie(first.headers["set-cookie"], "cogniplane_refresh")?.value).toBe(
      parseSetCookie(second.headers["set-cookie"], "cogniplane_refresh")?.value
    );
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("active");
    expect(
      harness.auditEvents.events.filter((event) =>
        event.type === "auth.refresh_token_reuse_detected"
      )
    ).toHaveLength(0);
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
    expect(cleared!.attrs.path).toBe("/auth");
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

  test("refresh past the absolute session lifetime revokes the family and clears the cookie", async () => {
    const familyId = "fid-absolute-expiry";
    const jti = "jti-absolute-expiry";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-expired",
      tid: "tenant-expired",
      jti,
      fid: familyId
    });
    await issueRefreshJti(harness.redis, {
      jti,
      familyId,
      ttlSeconds: 60,
      loginAtEpochSeconds: 0
    });

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "session_expired" });
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("revoked");
    const cleared = parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh");
    expect(cleared?.attrs.path).toBe("/auth");
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

  // A transient failure AFTER the jti is claimed is the dangerous case: the
  // token is already spent, so a naive 401 both drops the session for a blip
  // and sets up the client's retry to look like a replay and revoke the family.
  test("a DB failure after the claim restores the jti and returns a retryable 503", async () => {
    const familyId = "fid-transient";
    const jti = "jti-transient";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-transient",
      tid: "tenant-transient",
      jti,
      fid: familyId
    });
    await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });

    let failMembershipLookup = true;
    harness.pool
      .onQuery(/SELECT role FROM tenant_memberships/, () => {
        if (failMembershipLookup) throw new Error("connection terminated unexpectedly");
        return { rows: [{ role: "admin" }], rowCount: 1 };
      })
      .onQuery(/SELECT email FROM users/, () => ({
        rows: [{ email: "alice@example.com" }],
        rowCount: 1
      }));

    const failed = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });

    // 503 + Retry-After, not 401: the frontend clears auth state on any non-2xx,
    // so a 401 here logs the user out mid-conversation over a blip.
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "refresh_unavailable" });
    expect(failed.headers["retry-after"]).toBe("1");

    // The claim was undone, so the same cookie is usable again.
    expect(harness.redis.store.get(`refresh_jti:${jti}`)).toBe(familyId);
    expect(harness.redis.store.has(`refresh_rotation:${jti}`)).toBe(false);
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("active");

    // The retry succeeds rather than tripping replay detection.
    failMembershipLookup = false;
    const retried = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(retried.statusCode).toBe(200);
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("active");
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

  test("rejects a cross-site Origin before touching the refresh token (403)", async () => {
    const consumeRateLimit = vi.fn(async () => null);
    harness = await buildHarness({
      limits: { consumeRateLimit } as unknown as RequestLimitsInterface
    });
    const familyId = "fid-csrf";
    const jti = "jti-csrf";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-csrf",
      tid: "tenant-csrf",
      jti,
      fid: familyId
    });
    await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { origin: "https://evil.example" },
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_origin_mismatch" });
    // The jti must NOT have been consumed — the guard runs first.
    expect(harness.redis.store.has(`refresh_jti:${jti}`)).toBe(true);
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  test("rejects a cross-site Referer when no Origin is sent (403)", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { referer: "https://evil.example/attack" },
      cookies: { cogniplane_refresh: "anything" }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_origin_mismatch" });
  });

  test("allows a same-origin Origin matching API_ORIGIN", async () => {
    const familyId = "fid-same-origin";
    const oldJti = "jti-same-origin";
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
      headers: { origin: "http://localhost:3000" },
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { accessToken: string }).accessToken.length).toBeGreaterThan(0);
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
    expect(cleared!.attrs.path).toBe("/auth");
  });

  test("tolerates an absent refresh cookie (no Redis writes, 200)", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(harness.redis.store.size).toBe(0);
  });

  test("rate-limits before revoking the refresh-token family", async () => {
    const { limits } = createThrottledLimits();
    const throttled = await buildHarness({ limits });
    const familyId = "fid-throttled-logout";
    const jti = "jti-throttled-logout";
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-l",
      tid: "tenant-l",
      jti,
      fid: familyId
    });
    await issueRefreshJti(throttled.redis, { jti, familyId, ttlSeconds: 60 });

    const res = await throttled.app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expectRateLimited(res);
    expect(throttled.redis.store.get(`refresh_family:${familyId}`)).toBe("active");
    expect(parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh")).toBeNull();
  });

  test("rejects a cross-site Origin before revoking the family (403)", async () => {
    const consumeRateLimit = vi.fn(async () => null);
    harness = await buildHarness({
      limits: { consumeRateLimit } as unknown as RequestLimitsInterface
    });
    const familyId = "fid-logout-csrf";
    const jti = "jti-logout-csrf";
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
      headers: { origin: "https://evil.example" },
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_origin_mismatch" });
    // The family must still be active — a forged logout cannot revoke it.
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("active");
    expect(consumeRateLimit).not.toHaveBeenCalled();
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
