import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ForgotPasswordRequestSchema,
  LinkRedeemRequestSchema,
  LocalLoginRequestSchema,
  MyPasskeyVerifyRequestSchema,
  PasskeyEnrollVerifyRequestSchema,
  PasskeyLoginVerifyRequestSchema,
  PasskeyRenameRequestSchema,
  PasskeyStepUpOptionsRequestSchema,
  PasskeyStepUpRequestSchema,
  PasswordChangeRequestSchema,
  SecondFactorCodeRequestSchema,
  StepUpRequestSchema
} from "@cogniplane/shared-types";

import { type AppConfig, isPasswordRecoveryEnabled } from "../config.js";
import { BoundedTasks } from "../lib/bounded-tasks.js";
import { requireBrowserAuthOrigin } from "../lib/browser-auth-origin.js";
import { withTenantScope, type Pool } from "../lib/db.js";
import { normalizeEmail } from "../lib/email-address.js";
import { PasswordHasherBusyError } from "../lib/password-hash.js";
import { parseRequestInput } from "../lib/route-validation.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import {
  type LocalSessionIdentity,
  LocalAccountError,
  type RequestMeta
} from "../services/auth/local-account-service.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import { LOGIN_FLOW_TTL_SECONDS, type LoginFlow, type LoginFlowPurpose } from "../services/auth/login-flow-store.js";
import {
  flowKeyOf,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  type PasskeyChallengePurpose
} from "../services/auth/passkey-challenge-store.js";
import type { ThrottleKind, ThrottleOutcome } from "../services/auth/login-throttle.js";
import { STEP_UP_ROUTES } from "../services/auth/step-up-routes.js";
import type { AuthMethod } from "../lib/jwt.js";
import { clientIpKey, enforceRateLimit } from "../services/rate-limit-reply.js";
import type { RequestLimitsInterface } from "../services/request-limits.js";
import { clearRefreshCookie, prepareSession, setRefreshCookie } from "./auth-session.js";
import { requireStepUp } from "../services/auth/local-auth.js";

// Local accounts: sign-in (password, then a second factor or a forced
// enrolment), setup and reset links, step-up, and the signed-in user's own
// security settings. See docs/architecture/local-accounts.md.
// Registered only when `local` is in AUTH_LOGIN_TYPES. The public paths are
// listed in lib/auth-jwt.ts.

const FLOW_COOKIE = "cogniplane_login_flow";
const FLOW_COOKIE_ATTRIBUTES = { httpOnly: true, secure: true, sameSite: "none", path: "/auth/local" } as const;
// The id of the challenge record of a public passkey ceremony (passwordless
// sign-in, second factor, sign-in enrolment): it binds the answer to the
// browser that asked. Signed-in ceremonies send the id in the body instead;
// their record is bound to the session.
const CHALLENGE_COOKIE = "cogniplane_passkey_challenge";
const CHALLENGE_COOKIE_ATTRIBUTES = { httpOnly: true, secure: true, sameSite: "none", path: "/auth" } as const;
// Forgot-password requests handled after their answer, per process. The
// per-IP limit comes first; past this many waiting, a request is dropped.
const FORGOT_MAX_PENDING = 32;
// Shutdown waits this long for them, before the database pools close.
const FORGOT_DRAIN_MS = 5_000;

function requestMeta(request: FastifyRequest): RequestMeta {
  return { ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null };
}

function sessionBody(accessToken: string, identity: LocalSessionIdentity) {
  return {
    accessToken,
    user: {
      userId: identity.userId,
      email: identity.email,
      displayName: identity.displayName ?? identity.email,
      tenantId: identity.tenantId,
      role: identity.role
    }
  };
}

// On a route that already has an access token, a wrong password or code is
// 403, not 401: the frontend reads 401 as an expired token, would refresh,
// and would send the secret again.
const SECRET_FAILURES = new Set(["invalid_credentials", "invalid_code", "passkey_not_accepted"]);

/** Answers the errors every local route shares. Returns false for others. */
function sendKnownError(request: FastifyRequest, reply: FastifyReply, error: unknown): boolean {
  if (error instanceof LocalAccountError) {
    const authenticated = Boolean(request.auth?.userId);
    const status = authenticated && SECRET_FAILURES.has(error.code) ? 403 : error.status;
    reply.code(status).send({ error: error.code });
    return true;
  }
  if (error instanceof PasswordHasherBusyError) {
    request.log.warn("local auth: password hasher at capacity");
    reply.header("Retry-After", "1");
    reply.code(503).send({ error: "busy" });
    return true;
  }
  return false;
}

/** The second-factor methods of a proof, for a new session's amr. */
function strongMethodsOf(amr: readonly AuthMethod[]): AuthMethod[] {
  return amr.filter((method) => method === "otp" || method === "pkey");
}

function isLocalSession(request: FastifyRequest): boolean {
  return request.auth?.session?.authSource === "local";
}

export async function registerLocalAuthRoutes(
  app: FastifyInstance,
  {
    db,
    config,
    auditEvents,
    limits,
    localAuth
  }: {
    /** app_user pool. */
    db: Pool;
    config: AppConfig;
    auditEvents: AuditEventStore;
    limits?: RequestLimitsInterface;
    localAuth: LocalAuth;
  }
): Promise<void> {
  const { accounts, mfa, passkeys, challenges, flows, throttle, stepUp, refreshTokens } = localAuth;

  /**
   * The per-IP sign-in limit (`auth_sign_in`), shared by every sign-in step
   * and by the secret checks of a signed-in local user (step-up, password
   * change). It fails closed: an unthrottled secret check is the attack it
   * exists for. Refresh and sign-out have their own limit (auth-session.ts).
   */
  function limitSignIn(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    return enforceRateLimit(request, reply, limits, clientIpKey("auth_sign_in", request), { failClosed: true });
  }

  /**
   * Runs one secret check (password or second-factor code) under the
   * per-email throttle of its kind. A request before the deadline is refused
   * with 429 and changes nothing. A throttle that cannot be reached stops the
   * check (503): fail closed.
   */
  async function throttled<T>(
    reply: FastifyReply,
    kind: ThrottleKind,
    emailForKey: string,
    check: () => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    let admission;
    try {
      admission = await throttle.admit(kind, normalizeEmail(emailForKey));
    } catch (error) {
      reply.log.error({ err: error }, "local auth: sign-in throttle unavailable");
      reply.header("Retry-After", "1");
      reply.code(503).send({ error: "busy" });
      return { ok: false };
    }
    if (!admission.admitted) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil(admission.retryAfterMs / 1000))));
      reply.code(429).send({ error: "too_many_attempts" });
      return { ok: false };
    }
    let outcome: ThrottleOutcome = "aborted";
    try {
      const value = await check();
      outcome = "success";
      return { ok: true, value };
    } catch (error) {
      if (error instanceof LocalAccountError && SECRET_FAILURES.has(error.code)) outcome = "failure";
      throw error;
    } finally {
      await throttle.complete(admission.ticket, outcome).catch((error: unknown) => {
        reply.log.error({ err: error }, "local auth: sign-in throttle update failed");
      });
    }
  }

  /**
   * Starts a session and answers with it. `beforeSend` runs once the session
   * exists (for example, clearing the flow cookie): when the session cannot
   * start, the caller's catch still sees an untouched request.
   */
  async function startSession(
    reply: FastifyReply,
    identity: LocalSessionIdentity,
    amr: AuthMethod[],
    extra: object = {},
    beforeSend?: () => void
  ) {
    const prepared = await prepareSession(config, refreshTokens, { ...identity, amr });
    beforeSend?.();
    setRefreshCookie(reply, prepared.refreshToken);
    return reply.send({ ...sessionBody(prepared.accessToken, identity), ...extra });
  }

  /**
   * A session prepared inside an enrolment's transaction, before its commit
   * (prepareSession). An enrolment that replaces the recovery codes never
   * commits without the session whose answer shows them: if the session
   * cannot start, the enrolment rolls back.
   */
  function sessionInTransaction(amr: AuthMethod[]) {
    let prepared: { identity: LocalSessionIdentity; accessToken: string; refreshToken: string } | undefined;
    return {
      beforeCommit: async (identity: LocalSessionIdentity) => {
        prepared = { identity, ...(await prepareSession(config, refreshTokens, { ...identity, amr })) };
      },
      /** Answers with the prepared session; false when none was prepared. */
      send(reply: FastifyReply, extra: object = {}): boolean {
        if (!prepared) return false;
        setRefreshCookie(reply, prepared.refreshToken);
        reply.send({ ...sessionBody(prepared.accessToken, prepared.identity), ...extra });
        return true;
      }
    };
  }

  async function startFlow(
    reply: FastifyReply,
    identity: Pick<LocalSessionIdentity, "tenantId" | "userId" | "email" | "securityVersion">,
    amr: AuthMethod[],
    purpose: LoginFlowPurpose,
    createdAtMs?: number,
    methods: Array<"totp" | "passkey" | "recovery_code"> = ["totp", "recovery_code"],
    extra: { recoveryCodeHash?: string } = {}
  ) {
    const flowId = await flows.create({
      ...extra,
      tenantId: identity.tenantId,
      userId: identity.userId,
      email: identity.email,
      securityVersion: identity.securityVersion,
      amr,
      purpose
    }, createdAtMs);
    if (!flowId) return reply.code(401).send({ error: "sign_in_expired" });
    reply.setCookie(FLOW_COOKIE, flowId, { ...FLOW_COOKIE_ATTRIBUTES, maxAge: LOGIN_FLOW_TTL_SECONDS });
    return purpose === "mfa"
      ? reply.send({ next: "mfa", methods })
      : reply.send({ next: "enroll" });
  }

  /**
   * After the password (or a setup link): a second factor is due when the
   * account has one; an enrolment is due when the policy or a manager reset
   * asks for one; otherwise the session starts.
   */
  async function afterPassword(reply: FastifyReply, identity: LocalSessionIdentity) {
    const factors = await mfa.factorState(identity.tenantId, identity.userId);
    // Every enrolled factor keeps the account in the second step, also when
    // passkeys are off (no WEBAUTHN_RP_ID): then only the other methods are
    // offered, and a passkey-only account has its recovery codes left.
    if (factors.totpEnabled || factors.passkeyCount > 0) {
      return startFlow(reply, identity, ["pwd"], "mfa", undefined, [
        ...(factors.totpEnabled ? ["totp" as const] : []),
        ...(passkeys && factors.passkeyCount > 0 ? ["passkey" as const] : []),
        "recovery_code"
      ]);
    }
    if (factors.mfaRequired) return startFlow(reply, identity, ["pwd"], "enroll");
    return startSession(reply, identity, ["pwd"]);
  }

  /** The flow of this browser, if it is in one of the given steps (read only). */
  async function currentFlow(
    request: FastifyRequest,
    reply: FastifyReply,
    purposes: readonly LoginFlowPurpose[]
  ): Promise<{ id: string; flow: LoginFlow } | null> {
    const id = (request.cookies as Record<string, string | undefined>)?.[FLOW_COOKIE];
    const flow = await flows.read(id);
    if (!id || !flow || !purposes.includes(flow.purpose)) {
      reply.code(401).send({ error: "sign_in_expired" });
      return null;
    }
    return { id, flow };
  }

  /**
   * Takes this browser's flow for a step that spends something (a code, a
   * passkey answer): one atomic GETDEL, before any database work. A parallel
   * request for the same flow finds nothing. The step answers with a session
   * after its commit, or calls `putBack`.
   *
   * A failure never clears the flow cookie: the server state ends a flow,
   * and a late failure answer must not remove a cookie that a successful
   * answer has just set.
   */
  async function takeFlow(
    request: FastifyRequest,
    reply: FastifyReply,
    purposes: readonly LoginFlowPurpose[]
  ): Promise<{ id: string; flow: LoginFlow } | null> {
    const id = (request.cookies as Record<string, string | undefined>)?.[FLOW_COOKIE];
    const flow = await flows.consume(id);
    if (!id || !flow) {
      reply.code(401).send({ error: "sign_in_expired" });
      return null;
    }
    if (!purposes.includes(flow.purpose)) {
      await flows.restore(id, flow);
      reply.code(401).send({ error: "sign_in_expired" });
      return null;
    }
    return { id, flow };
  }

  /** A step did not finish: the flow comes back, and a wrong secret counts. */
  async function putBack(current: { id: string; flow: LoginFlow }, error?: unknown): Promise<void> {
    const failure = error instanceof LocalAccountError && SECRET_FAILURES.has(error.code);
    await flows.restore(current.id, current.flow, { failure });
  }

  /** The step finished; the flow was taken already. */
  function flowDone(reply: FastifyReply): void {
    reply.clearCookie(FLOW_COOKIE, FLOW_COOKIE_ATTRIBUTES);
  }

  /** Public flow routes: origin, JSON, per-IP limit, and the body. */
  async function guardPublic<T>(request: FastifyRequest, reply: FastifyReply, schema: { safeParse(input: unknown): unknown }) {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) return null;
    if (await limitSignIn(request, reply)) return null;
    const body = parseRequestInput(reply, schema as never, request.body);
    if (!body.ok) {
      reply.send(body.response);
      return null;
    }
    return body.value as T;
  }

  app.post("/auth/local/login", async (request, reply) => {
    const body = await guardPublic<{ email: string; password: string }>(request, reply, LocalLoginRequestSchema);
    if (!body) return reply;
    try {
      const result = await throttled(reply, "password", body.email, () =>
        accounts.signInWithPassword(body.email, body.password, requestMeta(request))
      );
      if (!result.ok) return reply;
      return afterPassword(reply, result.value);
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  // Account setup: the first password, then the policy's enrolment or a
  // session. Password reset: a new password only; the user then signs in.
  for (const [path, purpose] of [
    ["/auth/local/setup", "account_setup"],
    ["/auth/local/password/reset", "password_reset"]
  ] as const) {
    app.post(path, async (request, reply) => {
      const body = await guardPublic<{ token: string; password: string }>(request, reply, LinkRedeemRequestSchema);
      if (!body) return reply;
      try {
        const identity = await accounts.redeemLink(purpose, body.token, body.password, requestMeta(request));
        if (purpose === "password_reset") return reply.send({ ok: true });
        return afterPassword(reply, identity);
      } catch (error) {
        if (sendKnownError(request, reply, error)) return reply;
        throw error;
      }
    });
  }

  // "Forgot password": only with email on. The answer is the same 202 for
  // every address and goes out before any lookup, so neither its body nor
  // its time shows whether an account exists. The work (lookup, link, email
  // in the outbox) runs after it.
  if (isPasswordRecoveryEnabled(config)) {
    const recoveryTasks = new BoundedTasks(FORGOT_MAX_PENDING);
    // preClose runs before the onClose hook that ends the pools.
    app.addHook("preClose", async () => {
      recoveryTasks.close();
      if (!(await recoveryTasks.drain(FORGOT_DRAIN_MS))) {
        app.log.warn("local auth: password reset requests still running at shutdown");
      }
    });
    app.post("/auth/local/password/forgot", async (request, reply) => {
      const body = await guardPublic<{ email: string }>(request, reply, ForgotPasswordRequestSchema);
      if (!body) return reply;
      const meta = requestMeta(request);
      const log = request.log;
      // run() starts the work on a later turn, after this answer is sent.
      const started = recoveryTasks.run(
        async () => {
          const outcome = await accounts.requestPasswordReset(body.email, meta);
          log.info({ outcome }, "local auth: password reset request handled");
        },
        (error) => log.error({ err: error }, "local auth: password reset request failed")
      );
      if (!started) log.warn("local auth: too many password reset requests waiting, or shutting down; one was dropped");
      return reply.code(202).send({ ok: true });
    });
  }

  // Second factor: a code from the authenticator app.
  app.post("/auth/local/mfa/totp", async (request, reply) => {
    const body = await guardPublic<{ code: string }>(request, reply, SecondFactorCodeRequestSchema);
    if (!body) return reply;
    const current = await takeFlow(request, reply, ["mfa"]);
    if (!current) return reply;
    const { flow } = current;
    try {
      const result = await throttled(reply, "second_factor", flow.email, () =>
        mfa.verifyTotp(flow.tenantId, flow.userId, body.code, flow.securityVersion)
      );
      if (!result.ok) {
        await putBack(current);
        return reply;
      }
      return await startSession(reply, result.value, [...flow.amr, "otp"], {}, () => flowDone(reply));
    } catch (error) {
      await putBack(current, error);
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  // Second factor lost: a recovery code. It does not start a session; the
  // account must enrol a new authenticator first.
  app.post("/auth/local/mfa/recovery", async (request, reply) => {
    const body = await guardPublic<{ code: string }>(request, reply, SecondFactorCodeRequestSchema);
    if (!body) return reply;
    const current = await takeFlow(request, reply, ["mfa"]);
    if (!current) return reply;
    const { flow } = current;
    try {
      const result = await throttled(reply, "second_factor", flow.email, () =>
        mfa.checkRecoveryCode(flow.tenantId, flow.userId, body.code, flow.securityVersion)
      );
      if (!result.ok) {
        await putBack(current);
        return reply;
      }
      // A new flow for the enrolment, with the same deadline. It carries the
      // code's hash; the enrolment spends the code with the new factor.
      return await startFlow(reply, flow, [...flow.amr, "rec"], "recover", flow.createdAtMs, undefined, {
        recoveryCodeHash: result.value.codeHash
      });
    } catch (error) {
      await putBack(current, error);
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  // Forced enrolment during sign-in (policy, manager reset, or recovery).
  app.post("/auth/local/enroll/totp/start", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    if (await limitSignIn(request, reply)) return reply;
    const current = await currentFlow(request, reply, ["enroll", "recover"]);
    if (!current) return reply;
    try {
      const { flow } = current;
      return reply.send(await mfa.startTotpEnrollment(flow.tenantId, flow.userId, flow.securityVersion));
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.post("/auth/local/enroll/totp/confirm", async (request, reply) => {
    const body = await guardPublic<{ code: string }>(request, reply, SecondFactorCodeRequestSchema);
    if (!body) return reply;
    const current = await takeFlow(request, reply, ["enroll", "recover"]);
    if (!current) return reply;
    const { flow } = current;
    try {
      const session = sessionInTransaction([...flow.amr, "otp"]);
      const result = await throttled(reply, "second_factor", flow.email, () =>
        mfa.confirmTotpEnrollment(flow.tenantId, flow.userId, body.code, flow.securityVersion, requestMeta(request), {
          recoveryCodeHash: flow.recoveryCodeHash,
          beforeCommit: session.beforeCommit
        })
      );
      if (!result.ok) {
        await putBack(current);
        return reply;
      }
      flowDone(reply);
      session.send(reply, { recoveryCodes: result.value.recoveryCodes });
      return reply;
    } catch (error) {
      await putBack(current, error);
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  // Fresh proof for one sensitive action: the password, or a code from the
  // authenticator app. A code makes it strong (requireStepUp).
  app.post("/auth/step-up", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) return reply;
    const session = request.auth.session;
    if (!isLocalSession(request) || !session?.familyId || session.securityVersion === undefined) {
      return reply.code(403).send({ error: "login_type_not_allowed" });
    }
    // Before the check, like sign-in: a correct proof clears the per-email
    // throttle, so only the per-IP limit bounds the work.
    if (await limitSignIn(request, reply)) return reply;
    const body = parseRequestInput(reply, StepUpRequestSchema, request.body);
    if (!body.ok) return body.response;
    const { tenantId, userId } = request.auth;
    const proof = body.value;
    const sessionVersion = session.securityVersion;

    try {
      const amr: AuthMethod[] = "totpCode" in proof ? ["otp"] : ["pwd"];
      const result = "totpCode" in proof
        ? await throttled(reply, "second_factor", request.auth.email ?? userId, () =>
            mfa.verifyTotp(tenantId, userId, proof.totpCode, sessionVersion))
        : await throttled(reply, "password", request.auth.email ?? userId, () =>
            accounts.verifyOwnPassword(tenantId, userId, proof.password));
      if (!result.ok) return reply;
      const token = await stepUp.create(
        { userId, tenantId, familyId: session.familyId, securityVersion: sessionVersion, action: proof.action },
        amr
      );
      await auditEvents.create({
        tenantId, sessionId: null, userId, type: "auth.step_up", payload: { action: proof.action, amr },
        ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null
      });
      return reply.send({ stepUpToken: token.token, expiresInSeconds: token.expiresInSeconds });
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.get("/me/security", async (request, reply) => {
    if (!isLocalSession(request)) {
      return reply.send({
        loginType: "workos", passwordChangedAt: null, totpEnabled: false, passkeyCount: 0, recoveryCodesRemaining: 0, mfaRequired: false
      });
    }
    const { tenantId, userId } = request.auth;
    const row = await withTenantScope(db, tenantId, async (client) => {
      const result = await client.query<{ changed_at: Date }>(
        `SELECT changed_at FROM local_passwords WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      return result.rows[0];
    });
    const factors = await mfa.factorState(tenantId, userId);
    return reply.send({ loginType: "local", passwordChangedAt: row?.changed_at.toISOString() ?? null, ...factors });
  });

  /**
   * The methods of a session that replaces this one after a security change:
   * the methods this session was signed in with, plus the ones just checked
   * for the change. Never a method that nobody checked (a passwordless
   * session does not gain `pwd`).
   */
  function chainedAmr(request: FastifyRequest, checked: readonly AuthMethod[]): AuthMethod[] {
    return [...new Set([...(request.auth.session?.amr ?? []), ...checked])];
  }

  /**
   * A factor added from a session needs that session to be live: a logout
   * revokes the family, and the access token alone (up to its expiry) must
   * not register a credential. Writes 403 `step_up_required` otherwise.
   */
  async function requireActiveFamily(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const familyId = request.auth.session?.familyId;
    if (familyId && (await refreshTokens.isActive(familyId))) return true;
    reply.code(403).send({ error: "step_up_required" });
    return false;
  }

  /** Ends the current family; the security version already ends its tokens. */
  async function revokeCurrentFamily(request: FastifyRequest): Promise<void> {
    const familyId = request.auth.session?.familyId;
    if (!familyId) return;
    await refreshTokens.revoke(familyId).catch((error: unknown) => {
      request.log.warn({ err: error }, "local auth: old family revoke failed");
    });
  }

  /** Ends the current family and starts a new session for this browser. */
  async function replaceSession(request: FastifyRequest, reply: FastifyReply, identity: LocalSessionIdentity, amr: AuthMethod[], extra: object = {}) {
    await revokeCurrentFamily(request);
    return startSession(reply, identity, amr, extra);
  }

  /** Authenticated self-service routes on local sessions. */
  function localSessionVersion(request: FastifyRequest, reply: FastifyReply): number | null {
    const version = request.auth.session?.securityVersion;
    if (!isLocalSession(request) || version === undefined) {
      reply.code(403).send({ error: "login_type_not_allowed" });
      return null;
    }
    return version;
  }

  // Ends every session of the account, this one too, and starts a new one
  // for this browser. With a second factor, it also needs strong step-up.
  app.post("/me/security/password", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) return reply;
    const sessionVersion = localSessionVersion(request, reply);
    if (sessionVersion === null) return reply;
    if (await limitSignIn(request, reply)) return reply;
    const body = parseRequestInput(reply, PasswordChangeRequestSchema, request.body);
    if (!body.ok) return body.response;
    const { tenantId, userId } = request.auth;
    // The new session's amr follows the proof checked here. The service
    // refuses the change when the account's version moved since this
    // session (a factor added meanwhile), so the proof still holds.
    let proof: AuthMethod[] | null = null;
    if (await mfa.hasSecondFactor(tenantId, userId)) {
      proof = await requireStepUp(request, reply, localAuth, "POST /me/security/password");
      if (!proof) return reply;
    }
    try {
      const result = await throttled(reply, "password", request.auth.email ?? userId, () =>
        accounts.changeOwnPassword(
          tenantId, userId, body.value.currentPassword, body.value.newPassword, sessionVersion, requestMeta(request)
        )
      );
      if (!result.ok) return reply;
      // The current password was checked, plus the step-up's second factor.
      return replaceSession(request, reply, result.value, chainedAmr(request, ["pwd", ...strongMethodsOf(proof ?? [])]));
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  // Add an authenticator app, or replace one. Both need step-up: the password
  // when the account has no second factor yet, a second factor when it has
  // one (strong step-up). An access token alone must not add a factor that
  // locks the owner out. Confirm needs a code from the pending secret, and
  // only this answer (or a sign-in flow) shows that secret, so confirm needs
  // no step-up of its own. The pending secret is bound to this session
  // family: another session of the account cannot confirm it.
  // requireStepUp also checks the live family.
  app.post("/me/security/totp/start", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    if (!(await requireStepUp(request, reply, localAuth, "POST /me/security/totp/start"))) return reply;
    const { tenantId, userId } = request.auth;
    try {
      return reply.send(await mfa.startTotpEnrollment(tenantId, userId, version, { familyId: request.auth.session?.familyId }));
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.post("/me/security/totp/confirm", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    if (!(await requireActiveFamily(request, reply))) return reply;
    const body = parseRequestInput(reply, SecondFactorCodeRequestSchema, request.body);
    if (!body.ok) return body.response;
    const { tenantId, userId } = request.auth;
    try {
      const session = sessionInTransaction(chainedAmr(request, ["otp"]));
      const result = await throttled(reply, "second_factor", request.auth.email ?? userId, () =>
        mfa.confirmTotpEnrollment(tenantId, userId, body.value.code, version, requestMeta(request), {
          beforeCommit: session.beforeCommit,
          familyId: request.auth.session?.familyId
        })
      );
      if (!result.ok) return reply;
      // The new session was prepared before the commit; the old family ends.
      await revokeCurrentFamily(request);
      session.send(reply, { recoveryCodes: result.value.recoveryCodes });
      return reply;
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.delete("/me/security/totp", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    const proof = await requireStepUp(request, reply, localAuth, "DELETE /me/security/totp");
    if (!proof) return reply;
    const { tenantId, userId } = request.auth;
    try {
      const { identity } = await mfa.removeOwnTotp(tenantId, userId, version, requestMeta(request));
      return replaceSession(request, reply, identity, chainedAmr(request, proof));
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.post("/me/security/recovery-codes", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    if (!(await requireStepUp(request, reply, localAuth, "POST /me/security/recovery-codes"))) return reply;
    const { tenantId, userId } = request.auth;
    try {
      return reply.send({ recoveryCodes: await mfa.regenerateRecoveryCodes(tenantId, userId, version, requestMeta(request)) });
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  // Sign out everywhere: every session of the account ends, this one too.
  app.post("/me/security/sessions/revoke", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    if (!isLocalSession(request)) return reply.code(403).send({ error: "login_type_not_allowed" });
    const { tenantId, userId } = request.auth;
    try {
      await accounts.revokeSessions(tenantId, userId, userId, requestMeta(request));
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
    const familyId = request.auth.session?.familyId;
    if (familyId) {
      await refreshTokens.revoke(familyId).catch((error: unknown) => {
        request.log.warn({ err: error }, "sign out everywhere: family revoke failed");
      });
    }
    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });
  // Passkey routes exist only when passkeys are on (WEBAUTHN_RP_ID is set).
  if (!passkeys) return;
  const passkeyService = passkeys;

  /** Stores a public ceremony's challenge; the browser keeps only its id, in a cookie. */
  async function startPublicCeremony(
    reply: FastifyReply,
    challenge: string,
    purpose: PasskeyChallengePurpose,
    binding: { flowId?: string; flow?: LoginFlow } = {}
  ): Promise<void> {
    const id = await challenges.create({
      challenge,
      purpose,
      ...(binding.flow && binding.flowId
        ? {
            flowKey: flowKeyOf(binding.flowId),
            tenantId: binding.flow.tenantId,
            userId: binding.flow.userId,
            securityVersion: binding.flow.securityVersion
          }
        : {})
    });
    reply.setCookie(CHALLENGE_COOKIE, id, { ...CHALLENGE_COOKIE_ATTRIBUTES, maxAge: PASSKEY_CHALLENGE_TTL_SECONDS });
  }

  /**
   * The challenge of this browser's public ceremony, once, for this purpose
   * and (when given) this sign-in flow. Writes 401 `sign_in_expired` otherwise.
   */
  async function takePublicChallenge(
    request: FastifyRequest,
    reply: FastifyReply,
    purpose: PasskeyChallengePurpose,
    flowId?: string
  ): Promise<string | null> {
    const id = (request.cookies as Record<string, string | undefined>)?.[CHALLENGE_COOKIE];
    reply.clearCookie(CHALLENGE_COOKIE, CHALLENGE_COOKIE_ATTRIBUTES);
    const record = await challenges.consume(id, purpose);
    if (!record || (flowId !== undefined && record.flowKey !== flowKeyOf(flowId))) {
      reply.code(401).send({ error: "sign_in_expired" });
      return null;
    }
    return record.challenge;
  }

  // Passwordless sign-in: the browser offers the passkeys it has for this site.
  app.post("/auth/passkey/login/options", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    if (await limitSignIn(request, reply)) return reply;
    const options = await passkeyService.authenticationOptions();
    await startPublicCeremony(reply, options.challenge, "login");
    return reply.send({ options });
  });

  app.post("/auth/passkey/login/verify", async (request, reply) => {
    const body = await guardPublic<{ credential: never }>(request, reply, PasskeyLoginVerifyRequestSchema);
    if (!body) return reply;
    const challenge = await takePublicChallenge(request, reply, "login");
    if (!challenge) return reply;
    try {
      const identity = await passkeyService.verifyAssertion({
        credential: body.credential, expectedChallenge: challenge, meta: requestMeta(request)
      });
      return startSession(reply, identity, ["pkey"]);
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  // Second factor after the password: one of the account's passkeys.
  app.post("/auth/local/mfa/passkey/options", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    if (await limitSignIn(request, reply)) return reply;
    const current = await currentFlow(request, reply, ["mfa"]);
    if (!current) return reply;
    try {
      const options = await passkeyService.authenticationOptions(current.flow);
      await startPublicCeremony(reply, options.challenge, "second_factor", { flowId: current.id, flow: current.flow });
      return reply.send({ options });
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.post("/auth/local/mfa/passkey/verify", async (request, reply) => {
    const body = await guardPublic<{ credential: never }>(request, reply, PasskeyLoginVerifyRequestSchema);
    if (!body) return reply;
    const current = await takeFlow(request, reply, ["mfa"]);
    if (!current) return reply;
    const { id, flow } = current;
    try {
      // Inside the try: a Redis error here also puts the flow back.
      const challenge = await takePublicChallenge(request, reply, "second_factor", id);
      if (!challenge) {
        await putBack(current);
        return reply;
      }
      const identity = await passkeyService.verifyAssertion({
        credential: body.credential,
        expectedChallenge: challenge,
        expected: { tenantId: flow.tenantId, userId: flow.userId, securityVersion: flow.securityVersion },
        meta: requestMeta(request)
      });
      return await startSession(reply, identity, [...flow.amr, "pkey"], {}, () => flowDone(reply));
    } catch (error) {
      await putBack(current, error);
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  // Enrolment during sign-in (policy, manager reset, or recovery): a passkey
  // instead of an authenticator app.
  app.post("/auth/local/enroll/passkey/options", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    if (await limitSignIn(request, reply)) return reply;
    const current = await currentFlow(request, reply, ["enroll", "recover"]);
    if (!current) return reply;
    try {
      const { flow } = current;
      const options = await passkeyService.registrationOptions(flow.tenantId, flow.userId, flow.securityVersion);
      await startPublicCeremony(reply, options.challenge, "register", { flowId: current.id, flow });
      return reply.send({ options });
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.post("/auth/local/enroll/passkey/verify", async (request, reply) => {
    const body = await guardPublic<{ credential: never; name?: string }>(request, reply, PasskeyEnrollVerifyRequestSchema);
    if (!body) return reply;
    const current = await takeFlow(request, reply, ["enroll", "recover"]);
    if (!current) return reply;
    const { id, flow } = current;
    try {
      // Inside the try: a Redis error here also puts the flow back.
      const challenge = await takePublicChallenge(request, reply, "register", id);
      if (!challenge) {
        await putBack(current);
        return reply;
      }
      const session = sessionInTransaction([...flow.amr, "pkey"]);
      const result = await passkeyService.register({
        tenantId: flow.tenantId,
        userId: flow.userId,
        credential: body.credential,
        expectedChallenge: challenge,
        expectedVersion: flow.securityVersion,
        name: body.name,
        recoveryCodeHash: flow.recoveryCodeHash,
        beforeCommit: session.beforeCommit,
        meta: requestMeta(request)
      });
      flowDone(reply);
      // A sign-in enrolment is always a first factor or a recovery: the
      // session was prepared before the commit.
      if (!session.send(reply, { recoveryCodes: result.recoveryCodes ?? [] })) {
        return await startSession(reply, result.identity, [...flow.amr, "pkey"], { recoveryCodes: result.recoveryCodes ?? [] });
      }
      return reply;
    } catch (error) {
      await putBack(current, error);
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  /** A signed-in ceremony's record must belong to this session. */
  function boundToSession(
    request: FastifyRequest,
    record: { tenantId?: string; userId?: string; familyId?: string; securityVersion?: number } | null,
    version: number
  ): boolean {
    return Boolean(
      record &&
      record.tenantId === request.auth.tenantId &&
      record.userId === request.auth.userId &&
      record.familyId === request.auth.session?.familyId &&
      record.securityVersion === version
    );
  }

  // Step-up with a passkey (strong): options, then the answer for one action.
  app.post("/auth/step-up/passkey/options", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    if (await limitSignIn(request, reply)) return reply;
    const body = parseRequestInput(reply, PasskeyStepUpOptionsRequestSchema, request.body);
    if (!body.ok) return body.response;
    const { tenantId, userId } = request.auth;
    try {
      const options = await passkeyService.authenticationOptions({ tenantId, userId });
      const challengeId = await challenges.create({
        challenge: options.challenge, purpose: "step_up", tenantId, userId, securityVersion: version,
        familyId: request.auth.session?.familyId, action: body.value.action
      });
      return reply.send({ options, challengeId });
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.post("/auth/step-up/passkey", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    const familyId = request.auth.session?.familyId;
    if (!familyId) return reply.code(403).send({ error: "login_type_not_allowed" });
    if (await limitSignIn(request, reply)) return reply;
    if (!(await requireActiveFamily(request, reply))) return reply;
    const body = parseRequestInput(reply, PasskeyStepUpRequestSchema, request.body);
    if (!body.ok) return body.response;
    const { tenantId, userId } = request.auth;
    const record = await challenges.consume(body.value.challengeId, "step_up");
    if (!boundToSession(request, record, version) || record!.action !== body.value.action) {
      return reply.code(403).send({ error: "step_up_required" });
    }
    try {
      await passkeyService.verifyAssertion({
        credential: body.value.credential as never,
        expectedChallenge: record!.challenge,
        expected: { tenantId, userId, securityVersion: version },
        meta: requestMeta(request)
      });
      const amr: AuthMethod[] = ["pkey"];
      const token = await stepUp.create({ userId, tenantId, familyId, securityVersion: version, action: body.value.action }, amr);
      await auditEvents.create({
        tenantId, sessionId: null, userId, type: "auth.step_up", payload: { action: body.value.action, amr },
        ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null
      });
      return reply.send({ stepUpToken: token.token, expiresInSeconds: token.expiresInSeconds });
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.get("/me/security/passkeys", async (request, reply) => {
    if (localSessionVersion(request, reply) === null) return reply;
    return reply.send({ passkeys: await passkeyService.list(request.auth.tenantId, request.auth.userId) });
  });

  // Add a passkey. It always needs step-up: the password when the account has
  // no second factor yet, a second factor when it has one (strong step-up).
  // Without it, an access token alone could add a first passkey, sign in with
  // it without a password, and keep the account. The record carries the
  // step-up's action, and verify accepts no other record. requireStepUp also
  // checks the live family.
  app.post("/me/security/passkeys/options", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    if (!(await requireStepUp(request, reply, localAuth, "POST /me/security/passkeys/options"))) return reply;
    const { tenantId, userId } = request.auth;
    try {
      const options = await passkeyService.registrationOptions(tenantId, userId, version);
      const challengeId = await challenges.create({
        challenge: options.challenge, purpose: "register", tenantId, userId, securityVersion: version,
        familyId: request.auth.session?.familyId, action: STEP_UP_ROUTES["POST /me/security/passkeys/options"]
      });
      return reply.send({ options, challengeId });
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.post("/me/security/passkeys/verify", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    if (!(await requireActiveFamily(request, reply))) return reply;
    const body = parseRequestInput(reply, MyPasskeyVerifyRequestSchema, request.body);
    if (!body.ok) return body.response;
    const record = await challenges.consume(body.value.challengeId, "register");
    // Only a record from the options above, after their step-up. 409, not
    // 401: the access token is fine; the ceremony must start again.
    if (!boundToSession(request, record, version) || record!.action !== STEP_UP_ROUTES["POST /me/security/passkeys/options"]) {
      return reply.code(409).send({ error: "ceremony_expired" });
    }
    const { tenantId, userId } = request.auth;
    try {
      const session = sessionInTransaction(chainedAmr(request, ["pkey"]));
      const result = await passkeyService.register({
        tenantId,
        userId,
        credential: body.value.credential as never,
        expectedChallenge: record!.challenge,
        expectedVersion: version,
        name: body.value.name,
        beforeCommit: session.beforeCommit,
        meta: requestMeta(request)
      });
      // A first second factor ended every session; this browser gets the
      // new one, prepared before the commit.
      if (result.recoveryCodes) {
        await revokeCurrentFamily(request);
        session.send(reply, { passkey: result.passkey, recoveryCodes: result.recoveryCodes });
        return reply;
      }
      return reply.send({ passkey: result.passkey });
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.patch("/me/security/passkeys/:credentialId", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) return reply;
    if (localSessionVersion(request, reply) === null) return reply;
    const body = parseRequestInput(reply, PasskeyRenameRequestSchema, request.body);
    if (!body.ok) return body.response;
    const { credentialId } = request.params as { credentialId: string };
    try {
      return reply.send(await passkeyService.rename(request.auth.tenantId, request.auth.userId, credentialId, body.value.name));
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });

  app.delete("/me/security/passkeys/:credentialId", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) return reply;
    const version = localSessionVersion(request, reply);
    if (version === null) return reply;
    const proof = await requireStepUp(request, reply, localAuth, "DELETE /me/security/passkeys/:credentialId");
    if (!proof) return reply;
    const { credentialId } = request.params as { credentialId: string };
    const { tenantId, userId } = request.auth;
    try {
      const { identity } = await passkeyService.remove(tenantId, userId, credentialId, version, requestMeta(request));
      return replaceSession(request, reply, identity, chainedAmr(request, proof));
    } catch (error) {
      if (sendKnownError(request, reply, error)) return reply;
      throw error;
    }
  });
}
