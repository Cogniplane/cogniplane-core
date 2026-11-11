import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { decodeJwt } from "jose";
import { describe, expect, test, vi } from "vitest";

import { PasswordHasherBusyError } from "../lib/password-hash.js";
import { LocalAccountError, type LocalSessionIdentity } from "../services/auth/local-account-service.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import { InMemoryLoginThrottle, THROTTLE_THRESHOLD } from "../services/auth/login-throttle.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import { StepUpStore } from "../services/auth/step-up-store.js";
import { LoginFlowStore } from "../services/auth/login-flow-store.js";
import { PasskeyChallengeStore } from "../services/auth/passkey-challenge-store.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { RequestLimits, type RequestLimitsInterface } from "../services/request-limits.js";
import { registerLocalAuthRoutes } from "./auth-local.js";

// Route behaviour of local sign-in, links, step-up, and the user's own
// security settings. LocalAccountService is faked here; its SQL runs against
// real Postgres in integration/local-accounts.integration.test.ts.

const CONFIG = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["local"] });
const ORIGIN = CONFIG.API_ORIGIN;

const IDENTITY: LocalSessionIdentity = {
  tenantId: "tenant-1", userId: "user-1", role: "member", email: "alice@example.com", displayName: "Alice", securityVersion: 7
};

type SessionAuth = { authSource: "local" | "workos"; familyId?: string; securityVersion?: number; amr?: Array<"pwd" | "otp" | "pkey" | "rec"> };

const MAIL_CONFIG = createTestConfig({
  AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["local"], SMTP_URL: "smtps://smtp.example.test", MAIL_FROM: "no-reply@example.test"
});

async function buildHarness(opts: { session?: SessionAuth; limits?: RequestLimitsInterface; passkeys?: boolean; mail?: boolean } = {}) {
  const redis = new FakeRefreshTokenRedis();
  const refreshTokens = new RefreshTokenRotationService(redis, 60);
  const throttle = new InMemoryLoginThrottle();
  const accounts = {
    signInWithPassword: vi.fn(async (): Promise<LocalSessionIdentity> => IDENTITY),
    redeemLink: vi.fn(async (): Promise<LocalSessionIdentity> => IDENTITY),
    verifyOwnPassword: vi.fn(async () => ({ email: IDENTITY.email, passwordHash: "x" })),
    changeOwnPassword: vi.fn(async (): Promise<LocalSessionIdentity> => ({ ...IDENTITY, securityVersion: 8 })),
    revokeSessions: vi.fn(async () => undefined),
    requestPasswordReset: vi.fn(async (_email: string, _meta: object): Promise<string> => "sent")
  };
  const factorState = { totpEnabled: false, passkeyCount: 0, recoveryCodesRemaining: 0, mfaRequired: false };
  const mfa = {
    state: factorState,
    factorState: vi.fn(async () => ({ ...factorState })),
    hasSecondFactor: vi.fn(async () => factorState.totpEnabled || factorState.passkeyCount > 0),
    verifyTotp: vi.fn(async (): Promise<LocalSessionIdentity> => IDENTITY),
    checkRecoveryCode: vi.fn(async () => ({ identity: IDENTITY, codeHash: "code-hash-1" })),
    startTotpEnrollment: vi.fn(async () => ({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x" })),
    // As the service does: the new session is prepared before the commit.
    confirmTotpEnrollment: vi.fn(async (...args: unknown[]) => {
      const options = args[5] as { beforeCommit?: (identity: LocalSessionIdentity) => Promise<void> } | undefined;
      const identity = { ...IDENTITY, securityVersion: 8 };
      await options?.beforeCommit?.(identity);
      return { identity, recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] };
    }),
    removeOwnTotp: vi.fn(async () => ({ identity: { ...IDENTITY, securityVersion: 9 }, factorsLeft: false })),
    regenerateRecoveryCodes: vi.fn(async () => ["EEEE-FFFF-GGGG-HHHH"])
  };
  let challengeCount = 0;
  const PASSKEY = { id: "cred-1", name: "Passkey 1", createdAt: "2026-10-26T00:00:00.000Z", lastUsedAt: null, backedUp: true };
  const passkeys = {
    authenticationOptions: vi.fn(async () => ({ challenge: `chal-${++challengeCount}`, allowCredentials: [] })),
    registrationOptions: vi.fn(async () => ({ challenge: `reg-${++challengeCount}`, user: { id: "dXNlci0x" } })),
    verifyAssertion: vi.fn(async (_input: object): Promise<LocalSessionIdentity> => IDENTITY),
    register: vi.fn(async (input: { beforeCommit?: (identity: LocalSessionIdentity) => Promise<void> }) => {
      const identity = { ...IDENTITY, securityVersion: 8 };
      await input.beforeCommit?.(identity);
      return { identity, passkey: PASSKEY, recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] as string[] | null };
    }),
    list: vi.fn(async () => [PASSKEY]),
    rename: vi.fn(async () => ({ ...PASSKEY, name: "Laptop" })),
    remove: vi.fn(async () => ({ identity: { ...IDENTITY, securityVersion: 9 }, factorsLeft: true }))
  };
  // The session's family is live, as after a sign-in.
  if (opts.session?.familyId) await refreshTokens.issue({ jti: `jti-${opts.session.familyId}`, familyId: opts.session.familyId });
  const flows = new LoginFlowStore(redis);
  const localAuth = {
    accounts, mfa, flows, throttle, stepUp: new StepUpStore(redis), refreshTokens,
    passkeys: opts.passkeys ? passkeys : null, challenges: new PasskeyChallengeStore(redis)
  } as unknown as LocalAuth;
  const auditEvents = new InMemoryAuditEventStore();

  const app = Fastify();
  await app.register(cookie);
  if (opts.session) {
    const session = opts.session;
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: "user-1", tenantId: "tenant-1", role: "admin", isAdmin: true, email: "alice@example.com", session };
    });
  }
  await registerLocalAuthRoutes(app, {
    db: undefined as never,
    config: opts.mail ? MAIL_CONFIG : CONFIG,
    auditEvents: auditEvents as never,
    limits: opts.limits,
    localAuth
  });
  const post = (url: string, payload: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    app.inject({ method: "POST", url, payload: payload as object, headers });
  return { app, redis, refreshTokens, throttle, accounts, mfa, passkeys, flows, auditEvents, post };
}

function refreshCookie(res: { cookies: Array<{ name: string; value: string }> }) {
  return res.cookies.find((c) => c.name === "cogniplane_refresh");
}

describe("POST /auth/local/login", () => {
  test("starts a session that records the password method and the security version", async () => {
    const { post, accounts } = await buildHarness();
    const res = await post("/auth/local/login", { email: "Alice@Example.com", password: "a long passphrase here" });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ userId: "user-1", email: "alice@example.com", displayName: "Alice", tenantId: "tenant-1", role: "member" });
    const access = decodeJwt(res.json().accessToken);
    const refresh = decodeJwt(refreshCookie(res)!.value);
    expect(access).toMatchObject({ sub: "user-1", tid: "tenant-1", amr: ["pwd"], sv: 7 });
    expect(refresh).toMatchObject({ amr: ["pwd"], sv: 7 });
    // The access token names its session family, for step-up binding.
    expect(access.fid).toBe(refresh.fid);
    expect(accounts.signInWithPassword).toHaveBeenCalledWith("Alice@Example.com", "a long passphrase here", expect.any(Object));
  });

  test("answers every credential failure the same way, then throttles before checking", async () => {
    const { post, accounts } = await buildHarness();
    accounts.signInWithPassword.mockRejectedValue(new LocalAccountError("invalid_credentials"));

    for (let i = 0; i < THROTTLE_THRESHOLD; i += 1) {
      const res = await post("/auth/local/login", { email: "alice@example.com", password: "wrong" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_credentials" });
    }
    // The same email in another case is the same identifier.
    const throttled = await post("/auth/local/login", { email: " ALICE@example.com", password: "wrong" });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toEqual({ error: "too_many_attempts" });
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(accounts.signInWithPassword).toHaveBeenCalledTimes(THROTTLE_THRESHOLD);
  });

  test("a busy hasher is a retryable 503 that does not count as a failure", async () => {
    const { post, accounts, throttle } = await buildHarness();
    accounts.signInWithPassword.mockRejectedValue(new PasswordHasherBusyError());
    for (let i = 0; i < THROTTLE_THRESHOLD + 2; i += 1) {
      const res = await post("/auth/local/login", { email: "alice@example.com", password: "whatever" });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("1");
    }
    expect([...throttle.records.values()][0]?.fails ?? 0).toBe(0);
  });

  test("fails closed when the throttle cannot be reached", async () => {
    const { post, accounts, throttle } = await buildHarness();
    vi.spyOn(throttle, "admit").mockRejectedValue(new Error("redis down"));
    const res = await post("/auth/local/login", { email: "alice@example.com", password: "whatever" });
    expect(res.statusCode).toBe(503);
    expect(accounts.signInWithPassword).not.toHaveBeenCalled();
  });

  test.each([
    ["no Origin", {}, { email: "a@b.co", password: "x" }, 403],
    ["a cross-site Origin", { origin: "https://evil.example" }, { email: "a@b.co", password: "x" }, 403],
    ["a missing password", { origin: ORIGIN }, { email: "a@b.co" }, 400]
  ])("refuses %s before any check", async (_case, headers, payload, status) => {
    const { post, accounts } = await buildHarness();
    const res = await post("/auth/local/login", payload, headers as Record<string, string>);
    expect(res.statusCode).toBe(status);
    expect(accounts.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("one-time links", () => {
  test("account setup starts a session", async () => {
    const { post, accounts } = await buildHarness();
    const res = await post("/auth/local/setup", { token: "t".repeat(43), password: "a long passphrase here" });
    expect(res.statusCode).toBe(200);
    expect(decodeJwt(res.json().accessToken)).toMatchObject({ amr: ["pwd"], sv: 7 });
    expect(accounts.redeemLink).toHaveBeenCalledWith("account_setup", "t".repeat(43), "a long passphrase here", expect.any(Object));
  });

  test("password reset changes the password only: no session", async () => {
    const { post, accounts } = await buildHarness();
    const res = await post("/auth/local/password/reset", { token: "t".repeat(43), password: "a long passphrase here" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(refreshCookie(res)).toBeUndefined();
    expect(accounts.redeemLink).toHaveBeenCalledWith("password_reset", expect.any(String), expect.any(String), expect.any(Object));
  });

  test.each([
    ["link_invalid", 400],
    ["password_too_short", 400],
    ["password_contains_email", 400]
  ] as const)("answers %s with its code", async (code, status) => {
    const { post, accounts } = await buildHarness();
    accounts.redeemLink.mockRejectedValue(new LocalAccountError(code));
    const res = await post("/auth/local/setup", { token: "t".repeat(43), password: "x" });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: code });
  });
});

describe("POST /auth/step-up", () => {
  const LOCAL: SessionAuth = { authSource: "local", familyId: "family-1", securityVersion: 7, amr: ["pwd"] };

  test("a WorkOS session cannot step up with a password", async () => {
    const { post } = await buildHarness({ session: { authSource: "workos", familyId: "family-1" } });
    const res = await post("/auth/step-up", { action: "member.disable", password: "x" });
    expect(res.statusCode).toBe(403);
  });

  test("returns a token bound to the user, family, version, and action", async () => {
    const { post, redis, auditEvents } = await buildHarness({ session: LOCAL });
    const res = await post("/auth/step-up", { action: "member.disable", password: "my password value" });
    expect(res.statusCode).toBe(200);
    const stored = JSON.parse([...redis.store.values()].find((value) => value.includes("member.disable"))!);
    expect(stored).toEqual({
      userId: "user-1", tenantId: "tenant-1", familyId: "family-1", securityVersion: 7, action: "member.disable", amr: ["pwd"]
    });
    expect(auditEvents.events.map((event) => event.type)).toEqual(["auth.step_up"]);
  });

  // 403, not 401: the client reads 401 as an expired token and would retry.
  test("a wrong password is 403 and counts toward the throttle", async () => {
    const { post, accounts, throttle } = await buildHarness({ session: LOCAL });
    accounts.verifyOwnPassword.mockRejectedValue(new LocalAccountError("invalid_credentials"));
    const res = await post("/auth/step-up", { action: "member.disable", password: "wrong" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
    expect([...throttle.records.values()][0]?.fails).toBe(1);
  });
});

// Issue #47: public sign-in steps have a per-IP limit of their own, with the
// real limiter. Refresh and sign-out are not in it (routes/auth.test.ts).
describe("per-IP sign-in limit on public local steps", () => {
  test("a password spray over many emails from one IP stops at the sign-in limit, before the password check", async () => {
    const { app, accounts } = await buildHarness({ passkeys: true, limits: RequestLimits.fromAppConfig(CONFIG) });
    accounts.signInWithPassword.mockRejectedValue(new LocalAccountError("invalid_credentials"));
    let attempt = 0;
    const login = (ip: string) => app.inject({
      method: "POST", url: "/auth/local/login", remoteAddress: ip, headers: { origin: ORIGIN },
      payload: { email: `person${(attempt += 1)}@example.com`, password: "wrong password" }
    });

    const answers: number[] = [];
    for (let i = 0; i < 21; i += 1) answers.push((await login("198.51.100.1")).statusCode);
    const refused = await login("198.51.100.1");
    const passkeyStep = await app.inject({
      method: "POST", url: "/auth/passkey/login/options", remoteAddress: "198.51.100.1", headers: { origin: ORIGIN }
    });
    const otherIp = await login("198.51.100.2");

    // A different email each time, so the per-email throttle never answers.
    expect(answers).toEqual([...Array(20).fill(401), 429]);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: "limit_exceeded", resource: "auth_sign_in", scope: "user", limit: 20 });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(passkeyStep.statusCode).toBe(429);
    expect(accounts.signInWithPassword).toHaveBeenCalledTimes(21);
    expect(otherIp.statusCode).toBe(401);
  });
});

// Authenticated password checks spend Argon2 work too; a correct password
// clears the per-email throttle, so the per-IP limit must run first and fail
// closed.
describe("per-IP limit on authenticated password checks", () => {
  const LOCAL: SessionAuth = { authSource: "local", familyId: "family-1", securityVersion: 7, amr: ["pwd"] };
  const throttled = { consumeRateLimit: vi.fn(async () => ({ error: "limit_exceeded", retryAfterMs: 5000 })) } as unknown as RequestLimitsInterface;
  const broken = { consumeRateLimit: vi.fn(async () => { throw new Error("redis down"); }) } as unknown as RequestLimitsInterface;

  test.each([
    ["/auth/step-up", { action: "member.disable", password: "x" }, throttled, 429],
    ["/me/security/password", { currentPassword: "x", newPassword: "y" }, throttled, 429],
    ["/auth/step-up", { action: "member.disable", password: "x" }, broken, 503],
    ["/me/security/password", { currentPassword: "x", newPassword: "y" }, broken, 503]
  ] as const)("%s stops before the password check", async (url, payload, limits, status) => {
    const { post, accounts } = await buildHarness({ session: LOCAL, limits });
    const res = await post(url, payload);
    expect(res.statusCode).toBe(status);
    expect(accounts.verifyOwnPassword).not.toHaveBeenCalled();
    expect(accounts.changeOwnPassword).not.toHaveBeenCalled();
  });
});

describe("POST /auth/local/password/forgot", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test("answers 202 before the lookup starts, then hands the address to the service", async () => {
    const { post, accounts } = await buildHarness({ mail: true });
    // A lookup that never ends cannot hold the answer.
    accounts.requestPasswordReset.mockImplementation(() => new Promise<string>(() => {}));

    const res = await post("/auth/local/password/forgot", { email: "Alice@Example.com" });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    expect(res.cookies).toEqual([]);
    await settle();
    expect(accounts.requestPasswordReset).toHaveBeenCalledWith("Alice@Example.com", expect.objectContaining({ ipAddress: expect.any(String) }));
  });

  test("the answer is the same whatever the service finds, and a failure stays in the log", async () => {
    const { post, accounts } = await buildHarness({ mail: true });
    const answers = [];
    for (const outcome of [
      () => Promise.resolve("sent"), () => Promise.resolve("no_account"), () => Promise.resolve("not_active"),
      () => Promise.resolve("cooldown"), () => Promise.reject(new Error("database down"))
    ]) {
      accounts.requestPasswordReset.mockImplementationOnce(outcome);
      const res = await post("/auth/local/password/forgot", { email: "someone@example.com" });
      answers.push({ status: res.statusCode, body: res.body, headers: { ...res.headers, date: undefined } });
      await settle();
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(accounts.requestPasswordReset).toHaveBeenCalledTimes(5);
  });

  test("the origin check, the body check, and the per-IP limit come first", async () => {
    const throttled = { consumeRateLimit: vi.fn(async () => ({ error: "limit_exceeded", retryAfterMs: 5000 })) } as unknown as RequestLimitsInterface;
    const broken = { consumeRateLimit: vi.fn(async () => { throw new Error("redis down"); }) } as unknown as RequestLimitsInterface;
    for (const [harness, payload, headers, status] of [
      [{ mail: true }, { email: "a@example.com" }, { origin: "https://evil.example" }, 403],
      [{ mail: true }, { email: "" }, { origin: ORIGIN }, 400],
      [{ mail: true }, { email: "x".repeat(321) }, { origin: ORIGIN }, 400],
      [{ mail: true, limits: throttled }, { email: "a@example.com" }, { origin: ORIGIN }, 429],
      [{ mail: true, limits: broken }, { email: "a@example.com" }, { origin: ORIGIN }, 503]
    ] as const) {
      const { post, accounts } = await buildHarness(harness);
      const res = await post("/auth/local/password/forgot", payload, headers);
      expect(res.statusCode, JSON.stringify(payload)).toBe(status);
      await settle();
      expect(accounts.requestPasswordReset).not.toHaveBeenCalled();
    }
  });

  test("shutdown waits for a request that was answered but not yet handled", async () => {
    const { app, post, accounts } = await buildHarness({ mail: true });
    let release!: () => void;
    accounts.requestPasswordReset.mockImplementation(() => new Promise<string>((resolve) => { release = () => resolve("sent"); }));
    expect((await post("/auth/local/password/forgot", { email: "a@example.com" })).statusCode).toBe(202);
    await settle();
    expect(accounts.requestPasswordReset).toHaveBeenCalledTimes(1);

    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  });

  test("does not exist without email", async () => {
    const { post, accounts } = await buildHarness();
    const res = await post("/auth/local/password/forgot", { email: "a@example.com" });
    expect(res.statusCode).toBe(404);
    expect(accounts.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("the user's own security settings", () => {
  const LOCAL: SessionAuth = { authSource: "local", familyId: "family-old", securityVersion: 7, amr: ["pwd"] };

  test("a password change ends the old family and starts a session with the new version", async () => {
    const { post, refreshTokens } = await buildHarness({ session: LOCAL });
    await refreshTokens.issue({ jti: "jti-old", familyId: "family-old" });

    const res = await post("/me/security/password", { currentPassword: "old passphrase value", newPassword: "new passphrase value" });

    expect(res.statusCode).toBe(200);
    expect(await refreshTokens.isActive("family-old")).toBe(false);
    const access = decodeJwt(res.json().accessToken);
    expect(access.sv).toBe(8);
    expect(access.fid).not.toBe("family-old");
  });

  test("a password change binds to the session's version, and its amr follows the proof checked first", async () => {
    const harness = await buildHarness({ session: LOCAL });
    // A factor confirmed while the change runs: the service saw it as a
    // version change; the route must not upgrade the new session to otp.
    harness.accounts.changeOwnPassword.mockImplementation(async () => {
      harness.mfa.state.totpEnabled = true;
      return { ...IDENTITY, securityVersion: 8 };
    });
    const res = await harness.post("/me/security/password", { currentPassword: "old passphrase value", newPassword: "new passphrase value" });
    expect(harness.accounts.changeOwnPassword).toHaveBeenCalledWith(
      IDENTITY.tenantId, IDENTITY.userId, "old passphrase value", "new passphrase value", 7, expect.any(Object)
    );
    expect(decodeJwt(res.json().accessToken).amr).toEqual(["pwd"]);
  });

  test("a password change from a session older than the account is refused", async () => {
    const harness = await buildHarness({ session: LOCAL });
    harness.accounts.changeOwnPassword.mockRejectedValue(new LocalAccountError("session_changed"));
    const res = await harness.post("/me/security/password", { currentPassword: "old passphrase value", newPassword: "new passphrase value" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "session_changed" });
  });

  test("sign out everywhere bumps the version, ends this family, and clears the cookie", async () => {
    const { post, refreshTokens, accounts } = await buildHarness({ session: LOCAL });
    await refreshTokens.issue({ jti: "jti-old", familyId: "family-old" });

    const res = await post("/me/security/sessions/revoke", {});

    expect(res.statusCode).toBe(200);
    expect(accounts.revokeSessions).toHaveBeenCalledWith("tenant-1", "user-1", "user-1", expect.any(Object));
    expect(await refreshTokens.isActive("family-old")).toBe(false);
    const cleared = refreshCookie(res)!;
    expect(cleared.value).toBe("");
  });

  test("GET /me/security answers without a database read for a WorkOS session", async () => {
    const { app } = await buildHarness({ session: { authSource: "workos" } });
    const res = await app.inject({ method: "GET", url: "/me/security" });
    expect(res.json()).toEqual({
      loginType: "workos", passwordChangedAt: null, totpEnabled: false, passkeyCount: 0, recoveryCodesRemaining: 0, mfaRequired: false
    });
  });
});

// Second factors: the sign-in steps after the password.
describe("second-factor sign-in", () => {
  function flowCookie(res: { cookies: Array<{ name: string; value: string; path?: string; sameSite?: string }> }) {
    return res.cookies.find((c) => c.name === "cogniplane_login_flow");
  }

  async function passwordStep(harness: Awaited<ReturnType<typeof buildHarness>>) {
    const res = await harness.post("/auth/local/login", { email: "alice@example.com", password: "a long passphrase here" });
    return { res, flow: flowCookie(res)?.value ?? "" };
  }

  test("an account with an authenticator gets the second step, not a session", async () => {
    const harness = await buildHarness();
    harness.mfa.state.totpEnabled = true;
    const { res, flow } = await passwordStep(harness);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: "mfa", methods: ["totp", "recovery_code"] });
    expect(refreshCookie(res)).toBeUndefined();
    expect(flow).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flowCookie(res)).toMatchObject({ httpOnly: true, secure: true, path: "/auth/local" });
  });

  test("a valid code completes the sign-in with both methods, once", async () => {
    const harness = await buildHarness();
    harness.mfa.state.totpEnabled = true;
    const { flow } = await passwordStep(harness);
    const cookies = { cogniplane_login_flow: flow };

    const res = await harness.app.inject({ method: "POST", url: "/auth/local/mfa/totp", payload: { code: "123456" }, headers: { origin: ORIGIN }, cookies });
    expect(res.statusCode).toBe(200);
    expect(decodeJwt(res.json().accessToken)).toMatchObject({ amr: ["pwd", "otp"], sv: 7 });
    expect(harness.mfa.verifyTotp).toHaveBeenCalledWith("tenant-1", "user-1", "123456", 7);

    const replay = await harness.app.inject({ method: "POST", url: "/auth/local/mfa/totp", payload: { code: "123456" }, headers: { origin: ORIGIN }, cookies });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: "sign_in_expired" });
  });

  test("wrong codes count, and the flow ends after five", async () => {
    const harness = await buildHarness();
    harness.mfa.state.totpEnabled = true;
    harness.mfa.verifyTotp.mockRejectedValue(new LocalAccountError("invalid_code"));
    const { flow } = await passwordStep(harness);
    const send = () => harness.app.inject({
      method: "POST", url: "/auth/local/mfa/totp", payload: { code: "000000" }, headers: { origin: ORIGIN }, cookies: { cogniplane_login_flow: flow }
    });
    for (let i = 0; i < 5; i += 1) {
      const res = await send();
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_code" });
    }
    // The flow is read before the throttle, so the sixth try finds it gone.
    expect((await send()).json()).toEqual({ error: "sign_in_expired" });
    expect(harness.mfa.verifyTotp).toHaveBeenCalledTimes(5);
  });

  test("without the flow cookie, the second step is refused", async () => {
    const harness = await buildHarness();
    const res = await harness.post("/auth/local/mfa/totp", { code: "123456" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "sign_in_expired" });
    expect(harness.mfa.verifyTotp).not.toHaveBeenCalled();
  });

  test("a recovery code leads to a new enrolment, then a session with the new codes", async () => {
    const harness = await buildHarness();
    harness.mfa.state.totpEnabled = true;
    const { flow } = await passwordStep(harness);
    const cookies = { cogniplane_login_flow: flow };
    const post = (url: string, payload: object = {}) => harness.app.inject({ method: "POST", url, payload, headers: { origin: ORIGIN }, cookies });

    const recovered = await post("/auth/local/mfa/recovery", { code: "AAAA-BBBB-CCCC-DDDD" });
    expect(recovered.json()).toEqual({ next: "enroll" });
    expect(refreshCookie(recovered)).toBeUndefined();
    // The enrolment is a new flow: the code-step flow is spent.
    const next = recovered.cookies.filter((c) => c.name === "cogniplane_login_flow").at(-1)!.value;
    expect(next).not.toBe(flow);
    expect((await post("/auth/local/mfa/totp", { code: "123456" })).statusCode).toBe(401);
    cookies.cogniplane_login_flow = next;
    // A recovery flow cannot go back to the code step.
    expect((await post("/auth/local/mfa/totp", { code: "123456" })).statusCode).toBe(401);

    const started = await post("/auth/local/enroll/totp/start");
    expect(started.json()).toEqual({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x" });
    const confirmed = await post("/auth/local/enroll/totp/confirm", { code: "654321" });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().recoveryCodes).toEqual(["AAAA-BBBB-CCCC-DDDD"]);
    expect(decodeJwt(confirmed.json().accessToken)).toMatchObject({ amr: ["pwd", "rec", "otp"], sv: 8 });
  });

  test("two recovery requests on one flow at once: only one gets the flow, and no answer clears the cookie", async () => {
    const harness = await buildHarness();
    harness.mfa.state.totpEnabled = true;
    const { flow } = await passwordStep(harness);
    let release!: () => void;
    harness.mfa.checkRecoveryCode.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ identity: IDENTITY, codeHash: "code-hash-1" }); }));
    const post = () => harness.app.inject({
      method: "POST", url: "/auth/local/mfa/recovery", payload: { code: "AAAA-BBBB-CCCC-DDDD" },
      headers: { origin: ORIGIN }, cookies: { cogniplane_login_flow: flow }
    });

    const first = post();
    await vi.waitFor(() => expect(harness.mfa.checkRecoveryCode).toHaveBeenCalledTimes(1));
    // The first request took the flow before its database work.
    const second = await post();
    expect(second.json()).toEqual({ error: "sign_in_expired" });
    expect(flowCookie(second)).toBeUndefined();
    release();
    expect((await first).json()).toEqual({ next: "enroll" });
    expect(harness.mfa.checkRecoveryCode).toHaveBeenCalledTimes(1);
  });

  test("a wrong code puts the flow back with its deadline, and the next code works", async () => {
    const harness = await buildHarness();
    harness.mfa.state.totpEnabled = true;
    const { flow } = await passwordStep(harness);
    const before = await harness.flows.read(flow);
    harness.mfa.verifyTotp.mockRejectedValueOnce(new LocalAccountError("invalid_code"));
    const post = () => harness.app.inject({
      method: "POST", url: "/auth/local/mfa/totp", payload: { code: "000000" },
      headers: { origin: ORIGIN }, cookies: { cogniplane_login_flow: flow }
    });
    expect((await post()).statusCode).toBe(401);
    expect(await harness.flows.read(flow)).toEqual(before);
    expect((await post()).statusCode).toBe(200);
    expect(await harness.flows.read(flow)).toBeNull();
  });

  test("a recovery code is only checked; the enrolment flow carries its hash, and the enrolment spends it", async () => {
    const harness = await buildHarness();
    harness.mfa.state.totpEnabled = true;
    const { flow } = await passwordStep(harness);
    const post = (url: string, payload: object, cookie: string) => harness.app.inject({
      method: "POST", url, payload, headers: { origin: ORIGIN }, cookies: { cogniplane_login_flow: cookie }
    });
    const recovered = await post("/auth/local/mfa/recovery", { code: "AAAA-BBBB-CCCC-DDDD" }, flow);
    const next = recovered.cookies.filter((c) => c.name === "cogniplane_login_flow").at(-1)!.value;
    expect(await harness.flows.read(next)).toMatchObject({ purpose: "recover", recoveryCodeHash: "code-hash-1" });

    const confirmed = await post("/auth/local/enroll/totp/confirm", { code: "654321" }, next);
    expect(confirmed.statusCode).toBe(200);
    expect(harness.mfa.confirmTotpEnrollment).toHaveBeenCalledWith(
      "tenant-1", "user-1", "654321", 7, expect.any(Object), expect.objectContaining({ recoveryCodeHash: "code-hash-1" })
    );
    // A sign-in enrolment has no session family: it confirms only a secret
    // that a sign-in flow started.
    expect(harness.mfa.confirmTotpEnrollment.mock.calls[0]![5]).not.toHaveProperty("familyId");
  });

  test("an enrolment whose session cannot start answers an error and keeps the flow", async () => {
    const harness = await buildHarness();
    harness.mfa.state.mfaRequired = true;
    const { flow } = await passwordStep(harness);
    // The service rolls back when the session cannot be prepared before its commit.
    harness.mfa.confirmTotpEnrollment.mockImplementationOnce(async () => { throw new Error("redis down"); });
    const res = await harness.app.inject({
      method: "POST", url: "/auth/local/enroll/totp/confirm", payload: { code: "654321" },
      headers: { origin: ORIGIN }, cookies: { cogniplane_login_flow: flow }
    });
    expect(res.statusCode).toBe(500);
    expect(await harness.flows.read(flow)).not.toBeNull();
    expect(res.cookies.find((c) => c.name === "cogniplane_login_flow")).toBeUndefined();
  });

  test("a throttled code puts the flow back", async () => {
    const harness = await buildHarness();
    harness.mfa.state.totpEnabled = true;
    const { flow } = await passwordStep(harness);
    vi.spyOn(harness.throttle, "admit").mockResolvedValueOnce({ admitted: false, retryAfterMs: 1000 });
    const res = await harness.app.inject({
      method: "POST", url: "/auth/local/mfa/totp", payload: { code: "123456" },
      headers: { origin: ORIGIN }, cookies: { cogniplane_login_flow: flow }
    });
    expect(res.statusCode).toBe(429);
    expect(await harness.flows.read(flow)).not.toBeNull();
  });

  test("the policy or a manager reset forces an enrolment before any session", async () => {
    const harness = await buildHarness();
    harness.mfa.state.mfaRequired = true;
    const { res } = await passwordStep(harness);
    expect(res.json()).toEqual({ next: "enroll" });
    expect(refreshCookie(res)).toBeUndefined();
  });

  test("a setup link of an account the policy covers also leads to enrolment", async () => {
    const harness = await buildHarness();
    harness.mfa.state.mfaRequired = true;
    const res = await harness.post("/auth/local/setup", { token: "t".repeat(43), password: "a long passphrase here" });
    expect(res.json()).toEqual({ next: "enroll" });
  });
});

describe("second factors in the user's own settings", () => {
  const LOCAL: SessionAuth = { authSource: "local", familyId: "family-1", securityVersion: 7, amr: ["pwd"] };

  test("step-up with an authenticator code is strong", async () => {
    const harness = await buildHarness({ session: LOCAL });
    const res = await harness.post("/auth/step-up", { action: "self.totp_remove", totpCode: "123456" });
    expect(res.statusCode).toBe(200);
    const stored = JSON.parse([...harness.redis.store.values()].find((value) => value.includes("self.totp_remove"))!);
    expect(stored.amr).toEqual(["otp"]);
    expect(harness.mfa.verifyTotp).toHaveBeenCalledWith("tenant-1", "user-1", "123456", 7);
  });

  test("a step-up body with both or neither proof is refused", async () => {
    const harness = await buildHarness({ session: LOCAL });
    expect((await harness.post("/auth/step-up", { action: "self.totp_remove", password: "x", totpCode: "123456" })).statusCode).toBe(400);
    expect((await harness.post("/auth/step-up", { action: "self.totp_remove" })).statusCode).toBe(400);
  });

  test("with a factor, removing it, replacing it, or new codes need a strong step-up", async () => {
    const harness = await buildHarness({ session: LOCAL });
    harness.mfa.state.totpEnabled = true;
    await harness.refreshTokens.issue({ jti: "j", familyId: "family-1" });
    for (const [method, url] of [["DELETE", "/me/security/totp"], ["POST", "/me/security/totp/start"], ["POST", "/me/security/recovery-codes"]] as const) {
      const res = await harness.app.inject({ method, url, headers: { origin: ORIGIN } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toMatchObject({ error: "step_up_required" });
    }
    // A password step-up is not enough.
    const weak = await harness.post("/auth/step-up", { action: "self.recovery_codes", password: "my password value" });
    const res = await harness.app.inject({
      method: "POST", url: "/me/security/recovery-codes", headers: { origin: ORIGIN, "x-step-up": weak.json().stepUpToken }
    });
    expect(res.json()).toMatchObject({ error: "strong_step_up_required" });
    // A code step-up is.
    const strong = await harness.post("/auth/step-up", { action: "self.recovery_codes", totpCode: "123456" });
    const ok = await harness.app.inject({
      method: "POST", url: "/me/security/recovery-codes", headers: { origin: ORIGIN, "x-step-up": strong.json().stepUpToken }
    });
    expect(ok.json()).toEqual({ recoveryCodes: ["EEEE-FFFF-GGGG-HHHH"] });
  });

  // An access token alone must not add a first factor: the owner would then
  // need a second step that the token holder controls.
  test("the first authenticator needs a password step-up, then replaces the session with one that has otp", async () => {
    const harness = await buildHarness({ session: LOCAL });
    const start = (headers: Record<string, string> = {}) =>
      harness.app.inject({ method: "POST", url: "/me/security/totp/start", headers: { origin: ORIGIN, ...headers } });
    const denied = await start();
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "step_up_required" });
    expect(harness.mfa.startTotpEnrollment).not.toHaveBeenCalled();

    const step = await harness.post("/auth/step-up", { action: "self.totp_replace", password: "my password value" });
    const started = await start({ "x-step-up": step.json().stepUpToken });
    expect(started.statusCode).toBe(200);
    // The pending secret is bound to this session family, and confirm names it.
    expect(harness.mfa.startTotpEnrollment).toHaveBeenCalledWith("tenant-1", "user-1", 7, { familyId: "family-1" });
    const res = await harness.post("/me/security/totp/confirm", { code: "654321" });
    expect(res.statusCode).toBe(200);
    expect(harness.mfa.confirmTotpEnrollment).toHaveBeenCalledWith(
      "tenant-1", "user-1", "654321", 7, expect.any(Object), expect.objectContaining({ familyId: "family-1" })
    );
    expect(res.json().recoveryCodes).toHaveLength(1);
    expect(decodeJwt(res.json().accessToken)).toMatchObject({ amr: ["pwd", "otp"], sv: 8 });
    expect(await harness.refreshTokens.isActive("family-1")).toBe(false);
  });

  test("a wrong code on an authenticated route is 403, not 401", async () => {
    const harness = await buildHarness({ session: LOCAL });
    harness.mfa.confirmTotpEnrollment.mockRejectedValue(new LocalAccountError("invalid_code"));
    const res = await harness.post("/me/security/totp/confirm", { code: "000000" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "invalid_code" });
  });

  test("with a factor, a password change needs a strong step-up", async () => {
    const harness = await buildHarness({ session: LOCAL });
    harness.mfa.state.totpEnabled = true;
    const res = await harness.post("/me/security/password", { currentPassword: "x", newPassword: "y" });
    expect(res.json()).toMatchObject({ error: "step_up_required" });
    expect(harness.accounts.changeOwnPassword).not.toHaveBeenCalled();
  });
});

// Passkeys: the binding of each ceremony to its purpose, browser, flow, or
// session. The WebAuthn checks themselves run against the real library in
// integration/local-passkeys.integration.test.ts.
describe("passkeys", () => {
  const CHALLENGE_COOKIE = "cogniplane_passkey_challenge";
  const cookieOf = (res: Res, name: string) => res.cookies.filter((c) => c.name === name).at(-1);
  const ASSERTION = { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" } };
  const ATTESTATION = { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "AA" } };

  type Harness = Awaited<ReturnType<typeof buildHarness>>;
  type Res = Awaited<ReturnType<Harness["app"]["inject"]>>;
  const send = (h: Harness, url: string, payload: object, cookies: Record<string, string>) =>
    h.app.inject({ method: "POST", url, payload, headers: { origin: ORIGIN }, cookies }) as Promise<Res>;

  test("off without WEBAUTHN_RP_ID: no passkey route exists", async () => {
    const { post } = await buildHarness();
    expect((await post("/auth/passkey/login/options", {})).statusCode).toBe(404);
  });

  test("passwordless: the challenge is bound to the browser by an httpOnly cookie and works once", async () => {
    const h = await buildHarness({ passkeys: true });
    const options = await h.post("/auth/passkey/login/options", {});
    expect(options.json().options.challenge).toBe("chal-1");
    const cookie = cookieOf(options, CHALLENGE_COOKIE)!;
    expect(cookie).toMatchObject({ path: "/auth", httpOnly: true });

    const ok = await send(h, "/auth/passkey/login/verify", { credential: ASSERTION }, { [CHALLENGE_COOKIE]: cookie.value });
    expect(ok.statusCode).toBe(200);
    expect(decodeJwt(ok.json().accessToken)).toMatchObject({ amr: ["pkey"] });
    expect(h.passkeys.verifyAssertion).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: "chal-1" }));
    expect(h.passkeys.verifyAssertion.mock.calls[0]![0]).not.toHaveProperty("expected");

    const replay = await send(h, "/auth/passkey/login/verify", { credential: ASSERTION }, { [CHALLENGE_COOKIE]: cookie.value });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: "sign_in_expired" });
    const none = await h.post("/auth/passkey/login/verify", { credential: ASSERTION });
    expect(none.json()).toEqual({ error: "sign_in_expired" });
  });

  test("a refused passkey is the uniform 401", async () => {
    const h = await buildHarness({ passkeys: true });
    h.passkeys.verifyAssertion.mockRejectedValue(new LocalAccountError("passkey_not_accepted"));
    const cookie = cookieOf(await h.post("/auth/passkey/login/options", {}), CHALLENGE_COOKIE)!;
    const res = await send(h, "/auth/passkey/login/verify", { credential: ASSERTION }, { [CHALLENGE_COOKIE]: cookie.value });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "passkey_not_accepted" });
  });

  async function passwordStep(h: Harness) {
    const res = await h.post("/auth/local/login", { email: "alice@example.com", password: "a long passphrase here" });
    return { res, flow: cookieOf(res, "cogniplane_login_flow")?.value ?? "" };
  }

  test("second factor: offered after the password, bound to the flow, and not usable for another purpose", async () => {
    const h = await buildHarness({ passkeys: true });
    h.mfa.state.passkeyCount = 1;
    const { res, flow } = await passwordStep(h);
    expect(res.json()).toEqual({ next: "mfa", methods: ["passkey", "recovery_code"] });

    const options = await send(h, "/auth/local/mfa/passkey/options", {}, { cogniplane_login_flow: flow });
    expect(h.passkeys.authenticationOptions).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }));
    const challenge = cookieOf(options, CHALLENGE_COOKIE)!.value;

    // A second-factor challenge is not a passwordless one.
    const crossed = await send(h, "/auth/passkey/login/verify", { credential: ASSERTION }, { [CHALLENGE_COOKIE]: challenge });
    expect(crossed.json()).toEqual({ error: "sign_in_expired" });
    expect(h.passkeys.verifyAssertion).not.toHaveBeenCalled();
  });

  test("second factor: the passkey completes the flow with pwd and pkey", async () => {
    const h = await buildHarness({ passkeys: true });
    h.mfa.state.passkeyCount = 1;
    const { flow } = await passwordStep(h);
    const challenge = cookieOf(await send(h, "/auth/local/mfa/passkey/options", {}, { cogniplane_login_flow: flow }), CHALLENGE_COOKIE)!.value;
    const res = await send(h, "/auth/local/mfa/passkey/verify", { credential: ASSERTION }, { cogniplane_login_flow: flow, [CHALLENGE_COOKIE]: challenge });
    expect(res.statusCode).toBe(200);
    expect(decodeJwt(res.json().accessToken)).toMatchObject({ amr: ["pwd", "pkey"] });
    expect(h.passkeys.verifyAssertion).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "chal-1", expected: { tenantId: "tenant-1", userId: "user-1", securityVersion: 7 }
    }));
    // The flow is spent.
    expect((await send(h, "/auth/local/mfa/totp", { code: "123456" }, { cogniplane_login_flow: flow })).statusCode).toBe(401);
  });

  test("second factor: a challenge from another sign-in flow is refused", async () => {
    const h = await buildHarness({ passkeys: true });
    h.mfa.state.passkeyCount = 1;
    const first = await passwordStep(h);
    const second = await passwordStep(h);
    const challenge = cookieOf(await send(h, "/auth/local/mfa/passkey/options", {}, { cogniplane_login_flow: first.flow }), CHALLENGE_COOKIE)!.value;
    const res = await send(h, "/auth/local/mfa/passkey/verify", { credential: ASSERTION }, { cogniplane_login_flow: second.flow, [CHALLENGE_COOKIE]: challenge });
    expect(res.json()).toEqual({ error: "sign_in_expired" });
    expect(h.passkeys.verifyAssertion).not.toHaveBeenCalled();
  });

  test("passkeys do not count when they are off: the account goes to its other steps", async () => {
    const h = await buildHarness();
    h.mfa.state.passkeyCount = 1;
    h.mfa.state.totpEnabled = true;
    const { res } = await passwordStep(h);
    expect(res.json()).toEqual({ next: "mfa", methods: ["totp", "recovery_code"] });
  });

  test("sign-in enrolment with a passkey: a session with the new recovery codes; recovery replaces the codes", async () => {
    const h = await buildHarness({ passkeys: true });
    h.mfa.state.mfaRequired = true;
    const { flow } = await passwordStep(h);
    const challenge = cookieOf(await send(h, "/auth/local/enroll/passkey/options", {}, { cogniplane_login_flow: flow }), CHALLENGE_COOKIE)!.value;
    const res = await send(h, "/auth/local/enroll/passkey/verify", { credential: ATTESTATION, name: "Laptop" }, { cogniplane_login_flow: flow, [CHALLENGE_COOKIE]: challenge });
    expect(res.statusCode).toBe(200);
    expect(res.json().recoveryCodes).toEqual(["AAAA-BBBB-CCCC-DDDD"]);
    expect(decodeJwt(res.json().accessToken)).toMatchObject({ amr: ["pwd", "pkey"], sv: 8 });
    expect(h.passkeys.register).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "reg-1", expectedVersion: 7, name: "Laptop", recoveryCodeHash: undefined
    }));
  });

  const LOCAL: SessionAuth = { authSource: "local", familyId: "family-1", securityVersion: 7, amr: ["pwd"] };

  test("step-up with a passkey: bound to the session and the action; makes a strong token", async () => {
    const h = await buildHarness({ session: LOCAL, passkeys: true });
    const options = (await h.post("/auth/step-up/passkey/options", { action: "member.disable" })).json();
    expect(options.challengeId).toEqual(expect.any(String));

    const wrongAction = await h.post("/auth/step-up/passkey", { action: "member.remove", challengeId: options.challengeId, credential: ASSERTION });
    expect(wrongAction.json()).toMatchObject({ error: "step_up_required" });
    // The record is spent by that try.
    const second = (await h.post("/auth/step-up/passkey/options", { action: "member.disable" })).json();
    const ok = await h.post("/auth/step-up/passkey", { action: "member.disable", challengeId: second.challengeId, credential: ASSERTION });
    expect(ok.statusCode).toBe(200);
    const stored = JSON.parse([...h.redis.store.values()].find((value) => value.includes("member.disable") && value.includes("amr"))!);
    expect(stored.amr).toEqual(["pkey"]);
    expect(h.passkeys.verifyAssertion).toHaveBeenCalledWith(expect.objectContaining({
      expected: { tenantId: "tenant-1", userId: "user-1", securityVersion: 7 }
    }));
  });

  test("step-up with a passkey: a record of another session family is refused", async () => {
    const other = await buildHarness({ session: { ...LOCAL, familyId: "family-2" }, passkeys: true });
    const options = (await other.post("/auth/step-up/passkey/options", { action: "member.disable" })).json();
    // Same Redis, another family: replay the record in a harness of family-1.
    const h = await buildHarness({ session: LOCAL, passkeys: true });
    for (const [key, value] of other.redis.store) h.redis.store.set(key, value);
    const res = await h.post("/auth/step-up/passkey", { action: "member.disable", challengeId: options.challengeId, credential: ASSERTION });
    expect(res.json()).toMatchObject({ error: "step_up_required" });
    expect(h.passkeys.verifyAssertion).not.toHaveBeenCalled();
  });

  const passwordStepUp = async (h: Harness, action: string): Promise<string> =>
    (await h.post("/auth/step-up", { action, password: "my password value" })).json().stepUpToken;
  const passkeyOptions = (h: Harness, stepUpToken?: string) =>
    h.app.inject({
      method: "POST", url: "/me/security/passkeys/options", payload: {},
      headers: { origin: ORIGIN, ...(stepUpToken ? { "x-step-up": stepUpToken } : {}) }
    });

  // An access token alone must not add a first passkey: it signs in without
  // a password, and the owner would need a second step the token holder has.
  test("adding a passkey always needs step-up: the password without a factor, a second factor with one", async () => {
    const h = await buildHarness({ session: LOCAL, passkeys: true });
    const denied = await passkeyOptions(h);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "step_up_required" });
    expect(h.passkeys.registrationOptions).not.toHaveBeenCalled();

    const ok = await passkeyOptions(h, await passwordStepUp(h, "self.passkey_add"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().challengeId).toEqual(expect.any(String));

    h.mfa.state.totpEnabled = true;
    expect((await passkeyOptions(h)).json()).toMatchObject({ error: "step_up_required" });
    const weak = await passkeyOptions(h, await passwordStepUp(h, "self.passkey_add"));
    expect(weak.json()).toMatchObject({ error: "strong_step_up_required" });
  });

  test("adding a passkey: a first factor replaces the session and returns codes; a further one changes no session", async () => {
    const h = await buildHarness({ session: LOCAL, passkeys: true });
    const options = (await passkeyOptions(h, await passwordStepUp(h, "self.passkey_add"))).json();
    const first = await h.post("/me/security/passkeys/verify", { challengeId: options.challengeId, credential: ATTESTATION });
    expect(first.json()).toMatchObject({ passkey: { id: "cred-1" }, recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] });
    expect(decodeJwt(first.json().accessToken)).toMatchObject({ amr: ["pwd", "pkey"], sv: 8 });

    // The first factor replaced the session: the old one cannot add more,
    // also with a new step-up.
    const old = await passkeyOptions(h, await passwordStepUp(h, "self.passkey_add"));
    expect(old.json()).toMatchObject({ error: "step_up_required" });

    // Another passkey, from a live session: no new session.
    const next = await buildHarness({ session: LOCAL, passkeys: true });
    next.passkeys.register.mockResolvedValueOnce({ identity: IDENTITY, passkey: { ...(await next.passkeys.list())[0]!, id: "cred-2" }, recoveryCodes: null });
    const again = (await passkeyOptions(next, await passwordStepUp(next, "self.passkey_add"))).json();
    const second = await next.post("/me/security/passkeys/verify", { challengeId: again.challengeId, credential: ATTESTATION });
    expect(second.json()).toEqual({ passkey: expect.objectContaining({ id: "cred-2" }) });

    // A spent record: start again (409, so the client does not refresh its token).
    const stale = await next.post("/me/security/passkeys/verify", { challengeId: again.challengeId, credential: ATTESTATION });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "ceremony_expired" });
  });

  test("verify accepts only a record from the options after their step-up", async () => {
    const h = await buildHarness({ session: LOCAL, passkeys: true });
    h.mfa.state.mfaRequired = true;
    // Bound to this session, but made without a step-up (by an older release).
    const unproven = await new PasskeyChallengeStore(h.redis).create({
      challenge: "reg-x", purpose: "register", tenantId: "tenant-1", userId: "user-1", securityVersion: 7, familyId: "family-1"
    });
    // A sign-in enrolment record: bound to a flow, not to this session.
    const { flow } = await passwordStep(h);
    const enrolment = cookieOf(await send(h, "/auth/local/enroll/passkey/options", {}, { cogniplane_login_flow: flow }), CHALLENGE_COOKIE)!.value;
    // A step-up record for the same action: another purpose.
    const stepUpRecord = (await h.post("/auth/step-up/passkey/options", { action: "self.passkey_add" })).json().challengeId;

    for (const challengeId of [unproven, enrolment, stepUpRecord]) {
      const res = await h.post("/me/security/passkeys/verify", { challengeId, credential: ATTESTATION });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "ceremony_expired" });
    }
    expect(h.passkeys.register).not.toHaveBeenCalled();
  });

  test("removing a passkey needs step-up; the new session keeps the step-up's factor when one is left", async () => {
    const h = await buildHarness({ session: LOCAL, passkeys: true });
    await h.refreshTokens.issue({ jti: "jti-1", familyId: "family-1" });
    const denied = await h.app.inject({ method: "DELETE", url: "/me/security/passkeys/cred-1", headers: { origin: ORIGIN } });
    expect(denied.json()).toMatchObject({ error: "step_up_required" });

    const step = (await h.post("/auth/step-up/passkey/options", { action: "self.passkey_remove" })).json();
    const token = (await h.post("/auth/step-up/passkey", { action: "self.passkey_remove", challengeId: step.challengeId, credential: ASSERTION })).json().stepUpToken;
    const res = await h.app.inject({ method: "DELETE", url: "/me/security/passkeys/cred-1", headers: { origin: ORIGIN, "x-step-up": token } });
    expect(res.statusCode).toBe(200);
    expect(h.passkeys.remove).toHaveBeenCalledWith("tenant-1", "user-1", "cred-1", 7, expect.any(Object));
    expect(decodeJwt(res.json().accessToken)).toMatchObject({ amr: ["pwd", "pkey"], sv: 9 });
  });

  test("a logout between options and verification stops the registration", async () => {
    const h = await buildHarness({ session: LOCAL, passkeys: true });
    const options = (await passkeyOptions(h, await passwordStepUp(h, "self.passkey_add"))).json();
    await h.refreshTokens.revoke("family-1");
    const res = await h.post("/me/security/passkeys/verify", { challengeId: options.challengeId, credential: ATTESTATION });
    expect(res.json()).toMatchObject({ error: "step_up_required" });
    expect(h.passkeys.register).not.toHaveBeenCalled();
    // The same for the authenticator app.
    expect((await h.post("/me/security/totp/confirm", { code: "123456" })).json()).toMatchObject({ error: "step_up_required" });
  });

  test("passkeys turned off: a passkey-only account still gets a second step, with its recovery codes", async () => {
    const h = await buildHarness();
    h.mfa.state.passkeyCount = 1;
    h.mfa.state.mfaRequired = true;
    const { res } = await passwordStep(h);
    expect(res.json()).toEqual({ next: "mfa", methods: ["recovery_code"] });
    expect(refreshCookie(res)).toBeUndefined();
  });

  test("a password change confirmed with a passkey records pwd and pkey", async () => {
    const h = await buildHarness({ session: LOCAL, passkeys: true });
    h.mfa.state.passkeyCount = 1;
    const step = (await h.post("/auth/step-up/passkey/options", { action: "self.password_change" })).json();
    const token = (await h.post("/auth/step-up/passkey", { action: "self.password_change", challengeId: step.challengeId, credential: ASSERTION })).json().stepUpToken;
    const res = await h.app.inject({
      method: "POST", url: "/me/security/password", payload: { currentPassword: "old passphrase value", newPassword: "new passphrase value" },
      headers: { origin: ORIGIN, "x-step-up": token }
    });
    expect(res.statusCode).toBe(200);
    expect(decodeJwt(res.json().accessToken)).toMatchObject({ amr: ["pwd", "pkey"] });
    const refresh = refreshCookie(res)!.value;
    expect(decodeJwt(refresh)).toMatchObject({ amr: ["pwd", "pkey"] });
  });

  test("after a passwordless sign-in, a factor change never adds a password the user did not type", async () => {
    const h = await buildHarness({ session: { authSource: "local", familyId: "family-1", securityVersion: 7, amr: ["pkey"] }, passkeys: true });
    const step = (await h.post("/auth/step-up/passkey/options", { action: "self.passkey_remove" })).json();
    const token = (await h.post("/auth/step-up/passkey", { action: "self.passkey_remove", challengeId: step.challengeId, credential: ASSERTION })).json().stepUpToken;
    h.passkeys.remove.mockResolvedValueOnce({ identity: { ...IDENTITY, securityVersion: 9 }, factorsLeft: false });
    const res = await h.app.inject({ method: "DELETE", url: "/me/security/passkeys/cred-1", headers: { origin: ORIGIN, "x-step-up": token } });
    expect(decodeJwt(res.json().accessToken).amr).toEqual(["pkey"]);
    expect(decodeJwt(refreshCookie(res)!.value).amr).toEqual(["pkey"]);
  });

  test("a challenge-store error during a sign-in step puts the flow back", async () => {
    const h = await buildHarness({ passkeys: true });
    h.mfa.state.passkeyCount = 1;
    const { flow } = await passwordStep(h);
    const challenge = cookieOf(await send(h, "/auth/local/mfa/passkey/options", {}, { cogniplane_login_flow: flow }), CHALLENGE_COOKIE)!.value;
    const spy = vi.spyOn(PasskeyChallengeStore.prototype, "consume").mockRejectedValueOnce(new Error("redis down"));
    try {
      const res = await send(h, "/auth/local/mfa/passkey/verify", { credential: ASSERTION }, { cogniplane_login_flow: flow, [CHALLENGE_COOKIE]: challenge });
      expect(res.statusCode).toBe(500);
      expect(await h.flows.read(flow)).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
