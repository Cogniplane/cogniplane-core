import { test, expect, describe, beforeEach, vi } from "vitest";
import { decodeJwt } from "jose";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { OauthException, WorkOS } from "@workos-inc/node";

import { handleAppError } from "../app.js";
import { registerAuthRoutes, timingSafeEqualString } from "./auth.js";
import { resolveTenantMembershipRole } from "../services/auth/workos-tenant-provisioning.js";
import { signRefreshToken } from "../lib/jwt.js";
import { issueRefreshJti } from "../lib/refresh-token-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import { createFakeWorkOS, type FakeWorkOSHandlers } from "../test-helpers/fake-workos.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { FakeLimitRedis } from "../test-helpers/fake-limit-redis.js";
import { RedisRequestLimits, RequestLimitsUnavailableError } from "../services/redis-request-limits.js";
import {
  RequestLimits,
  type LimitExceededErrorPayload,
  type RequestLimitsInterface
} from "../services/request-limits.js";

// ──────────────────────────────────────────────────────────────────────────
// Pure-helper coverage (kept from the original auth.test.ts).
// ──────────────────────────────────────────────────────────────────────────


/**
 * The membership upsert as Postgres answers it: an existing row keeps its
 * role (`inserted` false); a new row takes the role the code sends.
 */
function membershipUpsert(existingRole: string | null) {
  return (_text: string, values: unknown[]) =>
    existingRole
      ? { rows: [{ role: existingRole, inserted: false }], rowCount: 1 }
      : { rows: [{ role: values[2], inserted: true }], rowCount: 1 };
}

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
  AUTH_MODE: "jwt",
  AUTH_LOGIN_TYPES: ["workos"],
  WORKOS_API_KEY: "test-workos-api-key",
  WORKOS_CLIENT_ID: "test-client-id",
  WORKOS_REDIRECT_URI: "https://test.example/auth/callback"
});
const TEST_PKCE_VERIFIER = "v".repeat(43);

type AuthStateRow = {
  role: string;
  login_type: string;
  auth_source: string;
  local_status?: string | null;
  security_version?: number | null;
};

type Harness = {
  app: FastifyInstance;
  /**
   * `app.inject` without the default frontend Origin, for the CSRF cases.
   * `app.inject` itself adds `Origin: API_ORIGIN` when a test sends none.
   */
  rawInject: FastifyInstance["inject"];
  /** What the membership lookup of refresh returns. null = not a member. */
  authState: { current: AuthStateRow | null; fail?: boolean };
  pool: FakePool;
  redis: FakeRefreshTokenRedis;
  workosMocks: FakeWorkOSHandlers;
  auditEvents: InMemoryAuditEventStore;
};

async function buildHarness(opts: {
  authPreHandler?: (request: { auth?: { userId: string; tenantId: string; isAdmin: boolean; role: "owner" | "admin" | "member" } & { email?: string } }) => void;
  limits?: RequestLimitsInterface;
  /** Receives every log line at warn level or higher. */
  logLines?: Array<{ level: number; msg: string } & Record<string, unknown>>;
  /** Fastify's `trustProxy`, as a TRUST_PROXY IP/CIDR list. Default: trust nothing. */
  trustProxy?: string;
} = {}): Promise<Harness> {
  const pool = new FakePool();
  const redis = new FakeRefreshTokenRedis();
  const { workos, mocks } = createFakeWorkOS();
  const auditEvents = new InMemoryAuditEventStore();
  const authState: Harness["authState"] = {
    current: { role: "member", login_type: "workos", auth_source: "workos" }
  };
  // Registered first, so it wins over any test handler for the same query.
  pool.onQuery(/SELECT tm\.role, t\.login_type, u\.auth_source/, () => {
    if (authState.fail) throw new Error("connection terminated unexpectedly");
    return authState.current ? { rows: [authState.current], rowCount: 1 } : { rows: [], rowCount: 0 };
  });

  const logLines = opts.logLines;
  const app = Fastify({
    ...(logLines ? { logger: { level: "warn", stream: { write: (line: string) => { logLines.push(JSON.parse(line)); } } } } : {}),
    ...(opts.trustProxy ? { trustProxy: opts.trustProxy } : {})
  });
  // The production error handler, so the tests see the status and body that
  // a client gets for an error the route does not handle.
  app.setErrorHandler(handleAppError);
  app.decorate("redis", redis.asAppRedis());
  await app.register(cookie);

  // Tests that hit auth-protected routes (/auth/me, /auth/organizations)
  // need `request.auth` populated. We don't run the real `jwtAuth`
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

  // Browsers send Origin on every POST; most tests are the real frontend.
  const rawInject = app.inject.bind(app) as FastifyInstance["inject"];
  (app as { inject: unknown }).inject = (opts: Record<string, unknown>) =>
    rawInject({
      ...opts,
      headers: { origin: TEST_CONFIG.API_ORIGIN, ...(opts.headers as Record<string, string> | undefined) }
    } as never);

  return { app, rawInject, authState, pool, redis, workosMocks: mocks, auditEvents };
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

// A deletion only works cross-site with the attributes the cookie was set
// with: a browser ignores a cross-site Set-Cookie without SameSite=None; Secure.
function expectRefreshCookieCleared(header: string | string[] | undefined) {
  const cleared = parseSetCookie(header, "cogniplane_refresh");
  expect(cleared).not.toBeNull();
  expect(cleared!.value).toBe("");
  expect(cleared!.attrs).toMatchObject({ path: "/auth", httponly: true, secure: true });
  expect(String(cleared!.attrs.samesite).toLowerCase()).toBe("none");
  expect(cleared!.attrs["max-age"] === "0" || cleared!.attrs.expires !== undefined).toBe(true);
}

// A refusal of /auth/refresh keeps the refresh cookie: the browser can hold a
// newer cookie from another tab when the answer arrives (auth-session.ts).
function expectRefreshCookieKept(header: string | string[] | undefined) {
  expect(parseSetCookie(header, "cogniplane_refresh")).toBeNull();
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
      resource: "auth_sign_in",
      userId: "127.0.0.1",
      tenantId: "127.0.0.1"
    });
    expect(throttled.workosMocks.getAuthorizationUrlWithPKCE).not.toHaveBeenCalled();
    expect(parseSetCookie(res.headers["set-cookie"], "cogniplane_oauth_state")).toBeNull();
  });
});

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

  const FLOW_COOKIES = {
    cogniplane_oauth_state: "the-state",
    cogniplane_oauth_pkce: TEST_PKCE_VERIFIER
  };

  // Both flow cookies are single use. Every answer after the rate limit
  // deletes them.
  function expectFlowCookiesCleared(header: string | string[] | undefined) {
    for (const name of ["cogniplane_oauth_state", "cogniplane_oauth_pkce"]) {
      const cleared = parseSetCookie(header, name);
      expect(cleared?.value).toBe("");
      expect(cleared?.attrs["max-age"] ?? cleared?.attrs.expires).toBeDefined();
    }
  }

  /**
   * Sends the code exchange through the installed WorkOS SDK, with `answer`
   * in place of the WorkOS API. The route then gets the exception that the
   * SDK makes from that answer.
   */
  function exchangeThroughSdk(answer: () => Promise<Response>) {
    const sdk = new WorkOS("test-workos-api-key", { fetchFn: answer, maxRetries: 0 });
    harness.workosMocks.authenticateWithCode.mockImplementation(
      (options: Parameters<WorkOS["userManagement"]["authenticateWithCode"]>[0]) =>
        sdk.userManagement.authenticateWithCode(options)
    );
  }

  const workosAnswer = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // The code goes to WorkOS and the state is compared with the cookie, so
  // both must be strings of a known size before either is used.
  test.each([
    ["an object code", { code: { length: 1 }, state: "the-state" }, "invalid_request"],
    ["an array code", { code: ["valid-code"], state: "the-state" }, "invalid_request"],
    ["a number code", { code: 12345, state: "the-state" }, "invalid_request"],
    ["a code over the size bound", { code: "c".repeat(513), state: "the-state" }, "invalid_request"],
    ["an empty code", { code: "", state: "the-state" }, "missing_code"],
    ["no code", { state: "the-state" }, "missing_code"],
    ["an object state", { code: "valid-code", state: { value: "the-state" } }, "invalid_request"],
    ["an array state", { code: "valid-code", state: ["the-state"] }, "invalid_request"],
    ["an empty state", { code: "valid-code", state: "" }, "invalid_state"],
    ["no state", { code: "valid-code" }, "invalid_state"],
    ["a state over the size bound", { code: "valid-code", state: "s".repeat(129) }, "invalid_state"],
    ["a body that is not an object", ["valid-code", "the-state"], "invalid_request"]
  ] as const)("refuses %s with 400 before it calls WorkOS", async (_case, payload, error) => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: payload as never,
      cookies: FLOW_COOKIES
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
    expect(harness.workosMocks.authenticateWithCode).not.toHaveBeenCalled();
    expectFlowCookiesCleared(res.headers["set-cookie"]);
  });

  test("sends a code at the size bound to WorkOS", async () => {
    seedWorkOSHappyPath();
    harness.workosMocks.listOrganizationMemberships.mockResolvedValue({ data: [] });
    const code = "c".repeat(512);

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code, state: "the-state" },
      cookies: FLOW_COOKIES
    });

    // The exchange ran; the user then has no organization.
    expect(res.json()).toEqual({ error: "no_organization" });
    expect(harness.workosMocks.authenticateWithCode).toHaveBeenCalledWith({
      code,
      clientId: "test-client-id",
      codeVerifier: TEST_PKCE_VERIFIER
    });
  });

  // WorkOS refuses a code it does not accept with the OAuth error
  // invalid_grant (HTTP 400). The user must start a new sign-in, so the
  // route answers like a refused local sign-in code: 401 invalid_code.
  test.each([
    ["an unknown code", "The code 'valid-code' is invalid."],
    ["an expired code", "The code 'valid-code' has expired."],
    ["a code used before", "The code 'valid-code' has already been used."],
    ["a verifier that does not match", "The code_verifier does not match the code_challenge."]
  ])("answers 401 invalid_code when WorkOS refuses %s", async (_case, description) => {
    const logLines: Array<{ level: number; msg: string } & Record<string, unknown>> = [];
    harness = await buildHarness({ logLines });
    exchangeThroughSdk(workosAnswer(400, { error: "invalid_grant", error_description: description }));

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "valid-code", state: "the-state" },
      cookies: FLOW_COOKIES
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_code" });
    expect(harness.workosMocks.authenticateWithCode).toHaveBeenCalledTimes(1);
    expect(harness.workosMocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(harness.pool.queries).toHaveLength(0);
    expectFlowCookiesCleared(res.headers["set-cookie"]);
    expect(parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh")).toBeNull();
    // The log names the refusal, but not the code, the state, the verifier
    // or what WorkOS answered.
    expect(logLines.map((line) => line.msg)).toContain("auth callback 401: WorkOS refused the authorization code");
    const logged = JSON.stringify(logLines);
    for (const secret of ["valid-code", "the-state", TEST_PKCE_VERIFIER, description, "invalid_grant"]) {
      expect(logged).not.toContain(secret);
    }
  });

  // Only a refused code is the client's fault. An outage, a wrong client
  // configuration or a failure after the exchange stays a server error.
  test.each([
    ["WorkOS is unavailable", workosAnswer(503, { message: "Service Unavailable" })],
    ["WorkOS cannot be reached", async () => { throw new TypeError("fetch failed"); }],
    ["WorkOS refuses the client", workosAnswer(400, { error: "invalid_client", error_description: "Invalid client secret." })],
    ["WorkOS refuses the API key", workosAnswer(401, { message: "Unauthorized" })],
    ["WorkOS limits the rate", workosAnswer(429, { message: "Too many requests" })]
  ] as const)("answers 500 when %s", async (_case, answer) => {
    exchangeThroughSdk(answer);

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "valid-code", state: "the-state" },
      cookies: FLOW_COOKIES
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", message: "An unexpected error occurred." });
    expectFlowCookiesCleared(res.headers["set-cookie"]);
    expect(parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh")).toBeNull();
  });

  test("an invalid_grant from the organization lookup after the exchange is not a refused code", async () => {
    seedWorkOSHappyPath();
    harness.workosMocks.listOrganizationMemberships.mockRejectedValue(
      new OauthException(400, "req_1", "invalid_grant", "Not the code exchange.", {})
    );

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/callback",
      payload: { code: "valid-code", state: "the-state" },
      cookies: FLOW_COOKIES
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", message: "An unexpected error occurred." });
  });

  test("first member of a tenant is promoted to owner; refresh JTI is issued; refresh cookie is scoped to /auth", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    // DB choreography: every multi-statement upsert returns the expected row.
    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({
        rows: [{ login_type: "workos", tenant_id: "tenant-uuid-1" }],
        rowCount: 1
      }))
      // No row holds this email yet → the INSERT path.
      .onQuery(/SELECT user_id, workos_user_id, auth_source FROM users WHERE email_key/, () => ({
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
      .onQuery(/INSERT INTO tenant_memberships/, membershipUpsert(null));

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
    // The session records how and when the user signed in.
    const claims = decodeJwt(body.accessToken);
    expect(claims.amr).toEqual(["workos"]);
    expect(Math.abs((claims.auth_time as number) - Date.now() / 1000)).toBeLessThan(60);
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

  // An email row with no WorkOS id (a seed row, or a local user, who never
  // has one) is not adopted by whoever signs in with that email. Adoption
  // would hand the row's data over without proof that the email is verified
  // or that the row belongs to this organization's tenant.
  test.each([
    ["a row with no WorkOS id", { auth_source: "workos" }],
    ["a local user's row", { auth_source: "local" }]
  ])("an email held by %s is refused with 409, not adopted", async (_case, row) => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    let userWritten = false;
    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ login_type: "workos", tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id, auth_source FROM users WHERE email_key/, () => ({
        rows: [{ user_id: "existing-user", workos_user_id: null, ...row }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO users|UPDATE users|INSERT INTO tenant_memberships/, () => {
        userWritten = true;
        return { rows: [{ user_id: "existing-user" }], rowCount: 1 };
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
    expect(userWritten).toBe(false);
    expect(parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh")).toBeNull();
  });

  // A WorkOS organization whose tenant uses
  // another login type gets no session, and the provisioning transaction
  // rolls back before any user or membership write.
  test("refuses an organization whose tenant does not use WorkOS login (403)", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    let laterQuery = false;
    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ login_type: "local", tenant_id: "t-local" }], rowCount: 1 }))
      .onQuery(/FROM users|INSERT INTO users|tenant_memberships/, () => {
        laterQuery = true;
        return { rows: [], rowCount: 0 };
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

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "wrong_login_type" });
    expect(laterQuery).toBe(false);
    expect(harness.pool.queries.some((q) => q.text.trim() === "ROLLBACK")).toBe(true);
    expect(parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh")).toBeNull();
  });

  // The callback creates a session, so a hostile page must not post a code of
  // its own (login CSRF).
  test.each([
    ["a cross-site Origin", { origin: "https://evil.example" }, { code: "valid-code", state: "the-state" }, 403],
    ["no Origin", {}, { code: "valid-code", state: "the-state" }, 403],
    ["a text body type", { origin: "http://localhost:3000", "content-type": "text/plain" }, "code=valid-code&state=the-state", 415],
    ["no body type", { origin: "http://localhost:3000" }, undefined, 415]
  ] as const)("rejects %s before exchanging the code", async (_case, headers, payload, status) => {
    const res = await harness.rawInject({
      method: "POST",
      url: "/auth/callback",
      headers,
      cookies: {
        cogniplane_oauth_state: "the-state",
        cogniplane_oauth_pkce: TEST_PKCE_VERIFIER
      },
      payload
    });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: status === 403 ? "csrf_origin_mismatch" : "unsupported_media_type" });
    expect(harness.workosMocks.authenticateWithCode).not.toHaveBeenCalled();
  });

  // The other side of the same lookup: taking over an email that a DIFFERENT
  // live identity holds would hand one person another's account.
  test("an email held by a different WorkOS identity is refused with 409, not taken over", async () => {
    seedWorkOSHappyPath({ workosRoleSlug: "member" });

    let membershipWritten = false;
    harness.pool
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ login_type: "workos", tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id, auth_source FROM users WHERE email_key/, () => ({
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
        return { rows: [{ login_type: "workos", tenant_id: "t1" }], rowCount: 1 };
      })
      .onQuery(/SELECT user_id, workos_user_id, auth_source FROM users WHERE email_key/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({
        rows: [{ cnt: "5" }],
        rowCount: 1
      }))
      .onQuery(/INSERT INTO tenant_memberships/, membershipUpsert("member"));

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
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ login_type: "workos", tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id, auth_source FROM users WHERE email_key/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({ rows: [{ cnt: "5" }], rowCount: 1 }))
      .onQuery(/INSERT INTO tenant_memberships/, membershipUpsert("owner"));

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
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ login_type: "workos", tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id, auth_source FROM users WHERE email_key/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({ rows: [{ cnt: "5" }], rowCount: 1 }))
      .onQuery(/INSERT INTO tenant_memberships/, membershipUpsert("member"));

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
      .onQuery(/INSERT INTO tenants/, () => ({ rows: [{ login_type: "workos", tenant_id: "t1" }], rowCount: 1 }))
      .onQuery(/SELECT user_id, workos_user_id, auth_source FROM users WHERE email_key/, () => ({ rows: [], rowCount: 0 }))
      .onQuery(/INSERT INTO users/, () => ({ rows: [{ user_id: "u1" }], rowCount: 1 }))
      .onQuery(/COUNT\(\*\)[\s\S]*FROM tenant_memberships/, () => ({ rows: [{ cnt: "5" }], rowCount: 1 }))
      .onQuery(/INSERT INTO tenant_memberships/, membershipUpsert("admin"));

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

  test("rate-limits before any store read or rotation of the refresh token", async () => {
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

  test("replay of an already-consumed jti revokes the family, emits audit, keeps the cookie, returns 401", async () => {
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

    // The cookie stays: the browser can hold a newer one from another tab.
    expectRefreshCookieKept(res.headers["set-cookie"]);

    // The kept cookie is dead: it gets 401 again, with no loop and no second audit.
    const again = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: "token_revoked" });
    expect(
      harness.auditEvents.events.filter((e) => e.type === "auth.refresh_token_reuse_detected")
    ).toHaveLength(1);
  });

  // The theft event must not depend on the database at the moment of the
  // detection. A 503 would be lost: the client's retry finds the family revoked,
  // and a revoked family does not detect reuse again.
  describe("a reuse detection whose audit write fails", () => {
    type LogLine = { level: number; msg: string } & Record<string, unknown>;
    const ERROR = 50;

    async function replayHarness(tag: string) {
      const logLines: LogLine[] = [];
      const h = await buildHarness({ logLines });
      const familyId = `fid-${tag}`;
      const jti = `jti-${tag}`;
      const refreshToken = await signRefreshToken(TEST_CONFIG, { sub: "user-t", tid: "tenant-t", jti, fid: familyId });
      // Issue, then consume: the next presentation of this jti is a replay.
      await issueRefreshJti(h.redis, { jti, familyId, ttlSeconds: 60 });
      await h.redis.getdel(`refresh_jti:${jti}`);
      const send = () => h.app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { "user-agent": "thief-agent" },
        cookies: { cogniplane_refresh: refreshToken }
      });
      const reuseEvents = () => h.auditEvents.events.filter((e) => e.type === "auth.refresh_token_reuse_detected");
      const marker = () => h.redis.store.get(`refresh_reuse_unaudited:${familyId}`);
      return { ...h, logLines, familyId, send, reuseEvents, marker };
    }

    test("still answers 401 with the family revoked, logs an error, and keeps a marker", async () => {
      const h = await replayHarness("audit-down");
      vi.spyOn(h.auditEvents, "create").mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

      const res = await h.send();

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "token_revoked" });
      expect(h.redis.store.get(`refresh_family:${h.familyId}`)).toBe("revoked");
      expectRefreshCookieKept(res.headers["set-cookie"]);
      expect(h.reuseEvents()).toEqual([]);
      const errors = h.logLines.filter((line) => line.level >= ERROR);
      expect(errors.map((line) => line.msg)).toEqual([
        "auth refresh: SECURITY: the audit event of a refresh-token reuse failed; the family is revoked"
      ]);
      expect(errors[0]).toMatchObject({ userId: "user-t", tenantId: "tenant-t", familyId: h.familyId });
      expect(JSON.parse(h.marker()!)).toMatchObject({ tenantId: "tenant-t", userId: "user-t", userAgent: "thief-agent" });
      // The marker lives as long as the revoked family state.
      expect(h.redis.setCalls.find((call) => call.key === `refresh_reuse_unaudited:${h.familyId}`)?.ttlSeconds)
        .toBe(h.redis.setCalls.find((call) => call.key === `refresh_family:${h.familyId}` && call.value === "revoked")?.ttlSeconds);
    });

    test("the next refusal of the family writes the event once, with the time of the detection", async () => {
      const h = await replayHarness("audit-late");
      vi.spyOn(h.auditEvents, "create").mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
      await h.send();
      const { detectedAt } = JSON.parse(h.marker()!) as { detectedAt: string };

      const retried = await h.send();

      expect(retried.statusCode).toBe(401);
      expect(retried.json()).toEqual({ error: "token_revoked" });
      expect(h.reuseEvents()).toHaveLength(1);
      expect(h.reuseEvents()[0]).toMatchObject({ userId: "user-t", payload: { familyId: h.familyId, detectedAt } });
      expect(h.marker()).toBeUndefined();

      // A later refusal writes no second event.
      const again = await h.send();
      expect(again.statusCode).toBe(401);
      expect(h.reuseEvents()).toHaveLength(1);
    });

    test("a late write that fails again keeps the marker for the next refusal", async () => {
      const h = await replayHarness("audit-down-twice");
      vi.spyOn(h.auditEvents, "create")
        .mockRejectedValueOnce(new Error("connection terminated unexpectedly"))
        .mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
      await h.send();

      const retried = await h.send();

      expect(retried.statusCode).toBe(401);
      expect(retried.json()).toEqual({ error: "token_revoked" });
      expect(h.reuseEvents()).toEqual([]);
      expect(h.marker()).toBeDefined();
      expect(h.logLines.filter((line) => line.level >= ERROR).map((line) => line.msg)).toContain(
        "auth refresh: SECURITY: the late audit event of a refresh-token reuse failed again; the marker stays"
      );

      await h.send();
      expect(h.reuseEvents()).toHaveLength(1);
      expect(h.marker()).toBeUndefined();
    });

    test("answers 401 and logs the detection when the marker cannot be written either", async () => {
      const h = await replayHarness("audit-and-marker-down");
      vi.spyOn(h.auditEvents, "create").mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
      const set = h.redis.set.bind(h.redis);
      vi.spyOn(h.redis, "set").mockImplementation(async (key, value, mode, ttl) => {
        if (key.startsWith("refresh_reuse_unaudited:")) throw new Error("redis unavailable");
        return set(key, value, mode, ttl);
      });

      const res = await h.send();

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "token_revoked" });
      expect(h.redis.store.get(`refresh_family:${h.familyId}`)).toBe("revoked");
      const errors = h.logLines.filter((line) => line.level >= ERROR);
      expect(errors.map((line) => line.msg)).toEqual([
        "auth refresh: SECURITY: the audit event of a refresh-token reuse failed; the family is revoked",
        "auth refresh: SECURITY: a refresh-token reuse has no audit event and no marker; this log is the only record"
      ]);
      expect(errors[1]).toMatchObject({ userId: "user-t", tenantId: "tenant-t", familyId: h.familyId });
    });

    test("a failed revoke answers 503 with the family active, and the retry revokes and audits", async () => {
      const h = await replayHarness("revoke-down");
      vi.spyOn(h.redis, "set").mockRejectedValueOnce(new Error("redis unavailable"));

      const failed = await h.send();

      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual({ error: "refresh_unavailable" });
      expect(h.redis.store.get(`refresh_family:${h.familyId}`)).toBe("active");
      expect(h.reuseEvents()).toEqual([]);

      const retried = await h.send();

      expect(retried.statusCode).toBe(401);
      expect(h.redis.store.get(`refresh_family:${h.familyId}`)).toBe("revoked");
      expect(h.reuseEvents()).toHaveLength(1);
      expect(h.reuseEvents()[0]!.payload).toEqual({ familyId: h.familyId });
    });
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
    expectRefreshCookieKept(res.headers["set-cookie"]);
  });

  test("refresh past the absolute session lifetime revokes the family and keeps the cookie", async () => {
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
    expectRefreshCookieKept(res.headers["set-cookie"]);

    // The kept cookie is dead: the next refresh gets 401 token_revoked.
    const again = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: "token_revoked" });
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

    harness.authState.current = null;

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not_a_member" });
    // The session ends for good: the family is revoked, so the token cannot
    // work again if the membership comes back. The cookie stays.
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("revoked");
    expectRefreshCookieKept(res.headers["set-cookie"]);
  });

  // If the revoke itself fails, the family is still active. A final 403 would
  // then be false: the same token would work again once the membership came
  // back. The route answers a retryable 503 and keeps the cookie instead.
  test("a failed family revoke after a refused membership is retryable, not final", async () => {
    const familyId = "fid-revoke-fails";
    const jti = "jti-revoke-fails";
    const refreshToken = await signRefreshToken(TEST_CONFIG, { sub: "user-r", tid: "tenant-r", jti, fid: familyId });
    await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });
    harness.authState.current = null;
    vi.spyOn(harness.redis, "set").mockRejectedValueOnce(new Error("redis unavailable"));

    const failed = await harness.app.inject({ method: "POST", url: "/auth/refresh", cookies: { cogniplane_refresh: refreshToken } });

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "refresh_unavailable" });
    expect(failed.headers["retry-after"]).toBe("1");
    expect(parseSetCookie(failed.headers["set-cookie"], "cogniplane_refresh")).toBeNull();
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("active");

    const retried = await harness.app.inject({ method: "POST", url: "/auth/refresh", cookies: { cogniplane_refresh: refreshToken } });

    expect(retried.statusCode).toBe(403);
    expect(harness.redis.store.get(`refresh_family:${familyId}`)).toBe("revoked");
    expectRefreshCookieKept(retried.headers["set-cookie"]);
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

    // The email read is the database call after the claim; the membership
    // lookup runs before the claim.
    let failEmailLookup = true;
    harness.pool.onQuery(/SELECT email FROM users/, () => {
      if (failEmailLookup) throw new Error("connection terminated unexpectedly");
      return { rows: [{ email: "alice@example.com" }], rowCount: 1 };
    });

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
    failEmailLookup = false;
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

  // Browsers send Origin on every POST, so a request without one is not the
  // frontend. A request with neither header must not get through.
  test.each([
    ["no Origin and a cross-site Referer", { referer: "https://evil.example/attack" }],
    ["no Origin and a same-site Referer", { referer: "http://localhost:3000/chat" }],
    ["neither Origin nor Referer", {}],
    ["Origin null", { origin: "null" }]
  ])("rejects a request with %s (403)", async (_case, headers) => {
    const res = await harness.rawInject({
      method: "POST",
      url: "/auth/refresh",
      headers,
      cookies: { cogniplane_refresh: "anything" }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_origin_mismatch" });
  });

  // A form post from a hostile page has a form body type. Bodyless calls and
  // JSON stay allowed while older frontends still send no body.
  // text/plain is a body type a hostile page can send without a preflight,
  // and Fastify parses it, so this is the guard's own refusal. (Fastify itself
  // refuses a form body type before the route runs.)
  test("rejects a non-JSON body type, accepts no body and JSON", async () => {
    const text = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { "content-type": "text/plain" },
      payload: "a=1"
    });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toEqual({ error: "unsupported_media_type" });

    for (const call of [{}, { payload: {} }]) {
      const res = await harness.app.inject({ method: "POST", url: "/auth/refresh", ...call });
      expect(res.json()).toEqual({ error: "missing_refresh_token" });
    }
  });

  // See docs/architecture/auth.md: the membership decides
  // before every answer, also the cached successor of a concurrent rotation,
  // which returns before any other database read.
  test("does not return a cached rotation result after the membership is gone", async () => {
    const familyId = "fid-cached";
    const jti = "jti-cached";
    const refreshToken = await signRefreshToken(TEST_CONFIG, { sub: "user-c", tid: "tenant-c", jti, fid: familyId });
    await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });
    harness.pool.onQuery(/SELECT email FROM users/, () => ({ rows: [{ email: "c@example.com" }], rowCount: 1 }));

    const first = await harness.app.inject({ method: "POST", url: "/auth/refresh", cookies: { cogniplane_refresh: refreshToken } });
    expect(first.statusCode).toBe(200);

    // The same token again, inside the grace window, would get the cached
    // result. The member was removed in between.
    harness.authState.current = null;
    const second = await harness.app.inject({ method: "POST", url: "/auth/refresh", cookies: { cogniplane_refresh: refreshToken } });

    expect(second.statusCode).toBe(403);
    expect(second.json()).toEqual({ error: "not_a_member" });
    expect(second.json()).not.toHaveProperty("accessToken");
  });

  test("refuses a member whose login path is not the tenant's (403)", async () => {
    const refreshToken = await signRefreshToken(TEST_CONFIG, { sub: "user-m", tid: "tenant-m", jti: "jti-m", fid: "fid-m" });
    await issueRefreshJti(harness.redis, { jti: "jti-m", familyId: "fid-m", ttlSeconds: 60 });
    harness.authState.current = { role: "member", login_type: "workos", auth_source: "local", local_status: "active", security_version: 0 };

    const res = await harness.app.inject({ method: "POST", url: "/auth/refresh", cookies: { cogniplane_refresh: refreshToken } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "login_type_not_allowed" });
    expectRefreshCookieKept(res.headers["set-cookie"]);
  });

  // The token is untouched before the claim, so a database failure there is a
  // retryable 503 and the same cookie still works afterwards.
  test("a membership lookup failure answers 503 without consuming the token", async () => {
    const refreshToken = await signRefreshToken(TEST_CONFIG, { sub: "user-f", tid: "tenant-f", jti: "jti-f", fid: "fid-f" });
    await issueRefreshJti(harness.redis, { jti: "jti-f", familyId: "fid-f", ttlSeconds: 60 });
    harness.pool.onQuery(/SELECT email FROM users/, () => ({ rows: [{ email: "f@example.com" }], rowCount: 1 }));
    harness.authState.fail = true;

    const failed = await harness.app.inject({ method: "POST", url: "/auth/refresh", cookies: { cogniplane_refresh: refreshToken } });

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "refresh_unavailable" });
    expect(failed.headers["retry-after"]).toBe("1");
    expect(harness.redis.store.get("refresh_jti:jti-f")).toBe("fid-f");

    harness.authState.fail = false;
    const retried = await harness.app.inject({ method: "POST", url: "/auth/refresh", cookies: { cogniplane_refresh: refreshToken } });
    expect(retried.statusCode).toBe(200);
  });

  test("keeps the sign-in method and time of the session it renews", async () => {
    const authTime = Math.floor(Date.now() / 1000) - 3600;
    const refreshToken = await signRefreshToken(TEST_CONFIG, {
      sub: "user-s", tid: "tenant-s", jti: "jti-s", fid: "fid-s", amr: ["workos"], auth_time: authTime
    });
    await issueRefreshJti(harness.redis, { jti: "jti-s", familyId: "fid-s", ttlSeconds: 60 });
    harness.pool.onQuery(/SELECT email FROM users/, () => ({ rows: [{ email: "s@example.com" }], rowCount: 1 }));

    const res = await harness.app.inject({ method: "POST", url: "/auth/refresh", cookies: { cogniplane_refresh: refreshToken } });

    expect(res.statusCode).toBe(200);
    const access = decodeJwt((res.json() as { accessToken: string }).accessToken);
    const refresh = decodeJwt(parseSetCookie(res.headers["set-cookie"], "cogniplane_refresh")!.value);
    for (const claims of [access, refresh]) {
      expect(claims.amr).toEqual(["workos"]);
      // A refresh never moves auth_time forward.
      expect(claims.auth_time).toBe(authTime);
    }
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
    expectRefreshCookieCleared(res.headers["set-cookie"]);
  });

  test("tolerates an absent refresh cookie (no Redis writes, 200)", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(harness.redis.store.size).toBe(0);
  });

  test.each(["invalid", "expired"])("treats an %s refresh token as signed out (no Redis writes, 200)", async (kind) => {
    let refreshToken = "not-a-real-jwt";
    if (kind === "expired") {
      // Sign the token 8 days ago: past its 7-day lifetime.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - 8 * 24 * 60 * 60 * 1000);
      try {
        refreshToken = await signRefreshToken(TEST_CONFIG, { sub: "user-l", tid: "tenant-l", jti: "jti-old", fid: "fid-old" });
      } finally {
        vi.useRealTimers();
      }
    }

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { cogniplane_refresh: refreshToken }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expectRefreshCookieCleared(res.headers["set-cookie"]);
    expect(harness.redis.setCalls).toEqual([]);
  });

  // A failed revocation leaves the family active. A 200 would tell the person
  // that the sign-out succeeded while a copy of the token still works.
  test("answers 503 and keeps the cookie when the revocation fails, and a retry revokes the family", async () => {
    const logLines: Array<{ level: number; msg: string } & Record<string, unknown>> = [];
    const h = await buildHarness({ logLines });
    const familyId = "fid-logout-redis-down";
    const jti = "jti-logout-redis-down";
    const refreshToken = await signRefreshToken(TEST_CONFIG, { sub: "user-l", tid: "tenant-l", jti, fid: familyId });
    await issueRefreshJti(h.redis, { jti, familyId, ttlSeconds: 60 });
    const logout = () => h.app.inject({ method: "POST", url: "/auth/logout", cookies: { cogniplane_refresh: refreshToken } });
    vi.spyOn(h.redis, "set").mockRejectedValueOnce(new Error("READONLY You can't write against a read only replica."));

    const failed = await logout();

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "logout_unavailable" });
    expect(failed.headers["retry-after"]).toBe("1");
    expect(failed.body).not.toContain("READONLY");
    expectRefreshCookieKept(failed.headers["set-cookie"]);
    expect(h.redis.store.get(`refresh_family:${familyId}`)).toBe("active");
    expect(logLines.filter((line) => line.level >= 50).map((line) => line.msg)).toEqual([
      "auth logout: refresh-family revocation failed"
    ]);

    const retried = await logout();

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ok: true });
    expectRefreshCookieCleared(retried.headers["set-cookie"]);
    expect(h.redis.store.get(`refresh_family:${familyId}`)).toBe("revoked");

    // A copy of the old refresh token cannot continue the session.
    const copied = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { cogniplane_refresh: refreshToken }
    });
    expect(copied.statusCode).toBe(401);
    expect(copied.json()).toEqual({ error: "token_revoked" });
    expect(parseSetCookie(copied.headers["set-cookie"], "cogniplane_refresh")).toBeNull();
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

// Issue #47. These tests use the real limiters, not a mock that refuses
// everything. Every injected request comes from 127.0.0.1, as when many
// people are behind one NAT or one proxy.
describe("auth rate limits, with the real limiter", () => {
  type Response = Awaited<ReturnType<Harness["app"]["inject"]>>;

  /** Sends until the first 429. Fails when no refusal comes. */
  async function untilRefused(send: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const res = await send();
      if (res.statusCode === 429) return res;
    }
    throw new Error("the limit never refused a request");
  }

  async function signIn(h: Harness, userId: string, familyId: string): Promise<string> {
    const jti = `jti-${familyId}`;
    await issueRefreshJti(h.redis, { jti, familyId, ttlSeconds: 60 });
    return signRefreshToken(TEST_CONFIG, { sub: userId, tid: "tenant-1", jti, fid: familyId });
  }

  function refresh(h: Harness, token?: string, extra: Record<string, unknown> = {}) {
    return h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      ...(token === undefined ? {} : { cookies: { cogniplane_refresh: token } }),
      ...extra
    });
  }

  function logout(h: Harness, token?: string) {
    return h.app.inject({
      method: "POST",
      url: "/auth/logout",
      ...(token === undefined ? {} : { cookies: { cogniplane_refresh: token } })
    });
  }

  function startWorkosLogin(h: Harness) {
    h.workosMocks.getAuthorizationUrlWithPKCE.mockResolvedValue({
      url: "https://api.workos.com/auth/authorize?state=stub",
      state: "s".repeat(43),
      codeVerifier: TEST_PKCE_VERIFIER
    });
  }

  async function harnessWith(limits: RequestLimitsInterface, opts: Parameters<typeof buildHarness>[0] = {}) {
    const h = await buildHarness({ ...opts, limits });
    h.pool.onQuery(/SELECT email FROM users/, () => ({ rows: [{ email: "person@example.com" }], rowCount: 1 }));
    startWorkosLogin(h);
    return h;
  }

  /** Records the subject of each limiter call, then asks the real limiter. */
  function recording(limits: RequestLimitsInterface) {
    const subjects: string[] = [];
    const wrapped = {
      consumeRateLimit: (input: Parameters<RequestLimitsInterface["consumeRateLimit"]>[0]) => {
        subjects.push(`${input.resource} ${input.userId}`);
        return limits.consumeRateLimit(input);
      }
    } as unknown as RequestLimitsInterface;
    return { subjects, limits: wrapped };
  }

  test("exhausting public sign-in on one IP does not block refresh or sign-out of the people behind it", async () => {
    const h = await harnessWith(RequestLimits.fromAppConfig(TEST_CONFIG));
    const loginRefused = await untilRefused(() => h.app.inject({ method: "GET", url: "/auth/login" }));
    const callbackRefused = await h.app.inject({ method: "POST", url: "/auth/callback", payload: { code: "c", state: "s" } });

    const alice = await refresh(h, await signIn(h, "user-alice", "fid-alice"));
    const bob = await refresh(h, await signIn(h, "user-bob", "fid-bob"));
    const carolOut = await logout(h, await signIn(h, "user-carol", "fid-carol"));

    expect(alice.statusCode).toBe(200);
    expect(bob.statusCode).toBe(200);
    expect(carolOut.statusCode).toBe(200);
    expect(h.redis.store.get("refresh_family:fid-carol")).toBe("revoked");
    expect(loginRefused.json()).toMatchObject({ error: "limit_exceeded", resource: "auth_sign_in", scope: "user", limit: 20 });
    expect(callbackRefused.statusCode).toBe(429);
    expect(h.workosMocks.authenticateWithCode).not.toHaveBeenCalled();
  });

  test("a revoked family that reaches its limit does not block another family of the same person", async () => {
    const h = await harnessWith(RequestLimits.fromAppConfig(TEST_CONFIG));
    const stolen = await signIn(h, "user-alice", "fid-stolen");
    h.redis.store.set("refresh_family:fid-stolen", "revoked");

    const refused = await untilRefused(() => refresh(h, stolen));
    const current = await refresh(h, await signIn(h, "user-alice", "fid-current"));
    expect(current.statusCode).toBe(200);
    const rotated = parseSetCookie(current.headers["set-cookie"], "cogniplane_refresh")!.value;
    const signedOut = await logout(h, rotated);

    expect(signedOut.statusCode).toBe(200);
    expect(h.redis.store.get("refresh_family:fid-current")).toBe("revoked");
    expect(refused.json()).toMatchObject({ error: "limit_exceeded", resource: "auth_refresh", scope: "user", limit: 60 });
    const retryAfter = Number(refused.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(retryAfter).toBe(Math.max(1, Math.ceil(refused.json().retryAfterMs / 1000)));
    // The abused family stays refused, for refresh and for sign-out.
    expect((await logout(h, stolen)).statusCode).toBe(429);
  });

  test("a forged or expired refresh token counts per IP and cannot use or exhaust a family's limit", async () => {
    const { limits, subjects } = recording(RequestLimits.fromAppConfig(TEST_CONFIG));
    const h = await harnessWith(limits);
    const victim = await signIn(h, "user-victim", "fid-victim");
    const claims = { sub: "user-victim", tid: "tenant-1", jti: "jti-forged", fid: "fid-victim" };
    const otherKey = await signRefreshToken({ ...TEST_CONFIG, JWT_SECRET: "a-secret-that-is-not-the-server-one!!" }, claims);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "none", kid: TEST_CONFIG.JWT_KEY_ID })}.${encode({ ...claims, iss: "cogniplane", aud: "cogniplane-refresh" })}.`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 8 * 24 * 60 * 60 * 1000);
    let expired: string;
    try {
      expired = await signRefreshToken(TEST_CONFIG, claims);
    } finally {
      vi.useRealTimers();
    }

    const refused = await untilRefused(async () => {
      for (const token of [otherKey, unsigned, expired]) {
        const res = await refresh(h, token);
        if (res.statusCode === 429) return res;
        expect(res.statusCode).toBe(401);
      }
      return logout(h, otherKey);
    });
    const victimRefresh = await refresh(h, victim);

    expect(victimRefresh.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ resource: "auth_refresh", scope: "user" });
    expect(new Set(subjects.slice(0, -1))).toEqual(new Set(["auth_refresh ip:127.0.0.1"]));
    expect(subjects.at(-1)).toBe("auth_refresh family:fid-victim");
  });

  test("refresh and sign-out without a cookie count per IP, apart from signed-in families", async () => {
    const h = await harnessWith(RequestLimits.fromAppConfig(TEST_CONFIG));

    const refused = await untilRefused(() => refresh(h));
    const outRefused = await logout(h);
    const signedIn = await refresh(h, await signIn(h, "user-alice", "fid-alice"));

    expect(signedIn.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ resource: "auth_refresh", scope: "user", limit: 60 });
    expect(outRefused.statusCode).toBe(429);
    expect(outRefused.headers["retry-after"]).toMatch(/^[1-9]\d*$/);
  });

  test("a limiter outage lets a valid refresh and sign-out through, and logs no token", async () => {
    const logLines: Array<{ level: number; msg: string } & Record<string, unknown>> = [];
    const limits = {
      consumeRateLimit: async () => { throw new RequestLimitsUnavailableError(new Error("connect ECONNREFUSED 10.1.2.3:6379")); }
    } as unknown as RequestLimitsInterface;
    const h = await harnessWith(limits, { logLines });
    const token = await signIn(h, "user-alice", "fid-outage");

    const refreshed = await refresh(h, token);
    const rotated = parseSetCookie(refreshed.headers["set-cookie"], "cogniplane_refresh")!.value;
    const signedOut = await logout(h, rotated);

    expect(refreshed.statusCode).toBe(200);
    expect(signedOut.statusCode).toBe(200);
    expect(h.redis.store.get("refresh_family:fid-outage")).toBe("revoked");
    expect(logLines.filter((line) => line.level === 40).map((line) => [line.msg, line.resource])).toEqual([
      ["rate limiter unavailable", "auth_refresh"],
      ["rate limiter unavailable", "auth_refresh"]
    ]);
    const logged = JSON.stringify(logLines);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(rotated);
    expect(logged).not.toContain("fid-outage");
  });

  test("the Redis limiter keys sign-in on the IP and refresh on the verified family, in the configured window", async () => {
    const fake = new FakeLimitRedis();
    const config = createTestConfig({ ...TEST_CONFIG, RATE_LIMIT_WINDOW_MS: 45_000 });
    const h = await harnessWith(RedisRequestLimits.fromAppConfig(fake.asRedis(), config));
    const token = await signIn(h, "user-alice", "fid-redis");

    expect((await h.app.inject({ method: "GET", url: "/auth/login" })).statusCode).toBe(200);
    expect((await refresh(h, token)).statusCode).toBe(200);
    expect((await refresh(h, "not-a-real-jwt")).statusCode).toBe(401);

    expect([...fake.counters.keys()]).toEqual([
      "rl:auth_sign_in:user:127.0.0.1",
      "rl:auth_refresh:user:family:fid-redis",
      "rl:auth_refresh:user:ip:127.0.0.1"
    ]);
    for (const key of fake.counters.keys()) {
      expect(fake.windowOf(key)).toBeGreaterThan(44_000);
      expect(fake.windowOf(key)).toBeLessThanOrEqual(45_000);
    }
  });

  describe("behind a proxy", () => {
    function viaProxy(h: Harness, client: string) {
      return () => h.app.inject({ method: "GET", url: "/auth/login", remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": client } });
    }

    test("with TRUST_PROXY set to the proxy, sign-in counts per client, and a forged X-Forwarded-For counts against its sender", async () => {
      const h = await harnessWith(RequestLimits.fromAppConfig(TEST_CONFIG), { trustProxy: "10.0.0.0/8" });

      await untilRefused(viaProxy(h, "203.0.113.7"));
      expect((await viaProxy(h, "203.0.113.8")()).statusCode).toBe(200);

      // A direct client outside the list cannot choose the IP of its bucket.
      const forging = () => h.app.inject({
        method: "GET", url: "/auth/login", remoteAddress: "198.51.100.9", headers: { "x-forwarded-for": "203.0.113.8" }
      });
      await untilRefused(forging);
      expect((await viaProxy(h, "203.0.113.8")()).statusCode).toBe(200);
    });

    test("with TRUST_PROXY=false behind a proxy, sign-in shares the proxy's bucket, but refresh stays per family", async () => {
      const h = await harnessWith(RequestLimits.fromAppConfig(TEST_CONFIG));

      await untilRefused(viaProxy(h, "203.0.113.7"));
      const neighbour = await viaProxy(h, "203.0.113.8")();
      const neighbourRefresh = await refresh(h, await signIn(h, "user-bob", "fid-bob"), {
        remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": "203.0.113.8" }
      });

      // The misconfiguration that the TRUST_PROXY boot warning names.
      expect(neighbour.statusCode).toBe(429);
      expect(neighbourRefresh.statusCode).toBe(200);
    });
  });
});

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

describe("GET /auth/organizations", () => {
  test("returns 401 when request.auth is missing", async () => {
    const harness = await buildHarness();
    const res = await harness.app.inject({ method: "GET", url: "/auth/organizations" });
    expect(res.statusCode).toBe(401);
  });

  test("refuses a local user without calling WorkOS (403)", async () => {
    const harness = await buildHarness({
      authPreHandler: (request) => {
        request.auth = { userId: "u-local", tenantId: "t", isAdmin: false, role: "member" };
      }
    });
    harness.pool.onQuery(/workos_user_id, auth_source FROM users/, () => ({
      rows: [{ workos_user_id: null, auth_source: "local" }],
      rowCount: 1
    }));

    const res = await harness.app.inject({ method: "GET", url: "/auth/organizations" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "login_type_not_allowed" });
    expect(harness.workosMocks.listOrganizationMemberships).not.toHaveBeenCalled();
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
    harness.pool.onQuery(/workos_user_id, auth_source FROM users/, () => ({
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
