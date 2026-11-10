import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { uuidv7 } from "../lib/uuid.js";

import type { AppConfig } from "../config.js";
import { checkAuthAdmission } from "../lib/auth-admission.js";
import { requireBrowserAuthOrigin } from "../lib/browser-auth-origin.js";
import type { Pool } from "../lib/db.js";
import {
  type AuthMethod,
  type RefreshTokenPayload,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken
} from "../lib/jwt.js";
import type { RefreshRotationResult, UnauditedReuse } from "../lib/refresh-token-store.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import { clientIp, enforceRateLimit, type RateLimitKey } from "../services/rate-limit-reply.js";
import type { RequestLimitsInterface } from "../services/request-limits.js";
import { PrivilegedAuthStateLookup } from "../services/tenant-member-store.js";

// The session layer that every login type shares: token issue, refresh with
// rotation and reuse detection, logout, and /auth/me. A login route proves who
// the user is, then calls `issueSession`; nothing here knows how that proof
// was made. See docs/architecture/auth.md.

export const REFRESH_COOKIE_NAME = "cogniplane_refresh";
export const REFRESH_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;
export const REFRESH_COOKIE_PATH = "/auth";

const REFRESH_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: REFRESH_COOKIE_PATH
} as const;

export function setRefreshCookie(reply: FastifyReply, refreshToken: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...REFRESH_COOKIE_ATTRIBUTES,
    maxAge: REFRESH_COOKIE_MAX_AGE_S
  });
}

// The deletion must carry the attributes the cookie was set with. The frontend
// calls the backend cross-site, and a browser ignores a cross-site Set-Cookie
// that lacks `SameSite=None; Secure`, so a bare `{ path }` would leave the
// old refresh cookie in place.
export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_ATTRIBUTES);
}

function sendRefreshResult(reply: FastifyReply, result: RefreshRotationResult): FastifyReply {
  setRefreshCookie(reply, result.refreshToken);
  return reply.send({ accessToken: result.accessToken });
}

const REUSE_EVENT = "auth.refresh_token_reuse_detected";

/**
 * Writes the audit event of a refresh-token reuse. The family is already
 * revoked, so this never throws: the answer must be the final 401. A 503
 * would be wrong, because the client's retry finds the family revoked and
 * writes no event. When the write fails, the failure is logged as an error,
 * and a marker in Redis keeps the detection: the next refusal of this family
 * writes the event (auditKeptReuse).
 */
async function auditReuse(
  request: FastifyRequest,
  refreshTokens: RefreshTokenRotationService,
  auditEvents: AuditEventStore,
  familyId: string,
  reuse: UnauditedReuse
): Promise<void> {
  const facts = { userId: reuse.userId, tenantId: reuse.tenantId, familyId, ipAddress: reuse.ipAddress };
  try {
    await auditEvents.create({
      tenantId: reuse.tenantId,
      sessionId: null,
      userId: reuse.userId,
      type: REUSE_EVENT,
      payload: { familyId },
      ipAddress: reuse.ipAddress,
      userAgent: reuse.userAgent
    });
    return;
  } catch (error) {
    request.log.error(
      { err: error, ...facts },
      "auth refresh: SECURITY: the audit event of a refresh-token reuse failed; the family is revoked"
    );
  }
  try {
    await refreshTokens.keepUnauditedReuse(familyId, reuse);
  } catch (error) {
    request.log.error(
      { err: error, ...facts },
      "auth refresh: SECURITY: a refresh-token reuse has no audit event and no marker; this log is the only record"
    );
  }
}

/**
 * Writes the audit event of an earlier reuse detection of this family whose
 * write failed, if a marker keeps one. Never throws: the answer stays 401.
 * The marker goes only after the write, so a crash between the two can write
 * the event twice, never zero times.
 */
async function auditKeptReuse(
  request: FastifyRequest,
  refreshTokens: RefreshTokenRotationService,
  auditEvents: AuditEventStore,
  familyId: string
): Promise<void> {
  let reuse: UnauditedReuse | null;
  try {
    reuse = await refreshTokens.readUnauditedReuse(familyId);
  } catch (error) {
    request.log.warn({ err: error, familyId }, "auth refresh: could not read the marker of an unaudited reuse");
    return;
  }
  if (!reuse) return;
  try {
    await auditEvents.create({
      tenantId: reuse.tenantId,
      sessionId: null,
      userId: reuse.userId,
      type: REUSE_EVENT,
      payload: { familyId, detectedAt: reuse.detectedAt },
      ipAddress: reuse.ipAddress,
      userAgent: reuse.userAgent
    });
  } catch (error) {
    request.log.error(
      { err: error, userId: reuse.userId, tenantId: reuse.tenantId, familyId },
      "auth refresh: SECURITY: the late audit event of a refresh-token reuse failed again; the marker stays"
    );
    return;
  }
  try {
    await refreshTokens.clearUnauditedReuse(familyId);
  } catch (error) {
    request.log.warn({ err: error, familyId }, "auth refresh: could not remove the marker of a written reuse event");
  }
}

/** The claims of a refresh token whose signature and lifetime are valid, or null. */
async function verifiedRefreshToken(config: AppConfig, token: string | undefined): Promise<RefreshTokenPayload | null> {
  if (!token) return null;
  try {
    return await verifyRefreshToken(config, token);
  } catch {
    return null;
  }
}

/**
 * The limit of /auth/refresh and /auth/logout (`auth_refresh`). A verified
 * token counts against its refresh family, so the people behind one IP, and
 * the other sign-ins of one person, do not share a count; a revoked family can
 * use up only its own. A request without a valid token counts against the
 * client IP. The subject never comes from a claim that was not verified.
 */
function refreshRateLimitKey(request: FastifyRequest, payload: RefreshTokenPayload | null): RateLimitKey {
  const subject = payload ? `family:${payload.fid}` : `ip:${clientIp(request)}`;
  return { resource: "auth_refresh", userId: subject, tenantId: subject };
}

function requireRefreshTokenStore(app: FastifyInstance) {
  if (!app.redis) {
    throw new Error("Redis is required for refresh token revocation.");
  }

  return app.redis;
}

export function createRefreshTokenRotationService(app: FastifyInstance): RefreshTokenRotationService {
  return new RefreshTokenRotationService(requireRefreshTokenStore(app), REFRESH_COOKIE_MAX_AGE_S);
}

export type SessionIdentity = {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
  /** How the user proved who they are for this sign-in. */
  amr: AuthMethod[];
  /** Local accounts: the account's security_version now. */
  securityVersion?: number;
};

/**
 * Starts a new session: a new refresh family, its first refresh token in the
 * cookie, and an access token for the response body. `auth_time` is now; every
 * later refresh of this family keeps it.
 */
export async function issueSession(
  reply: FastifyReply,
  config: AppConfig,
  refreshTokens: RefreshTokenRotationService,
  identity: SessionIdentity
): Promise<string> {
  const prepared = await prepareSession(config, refreshTokens, identity);
  setRefreshCookie(reply, prepared.refreshToken);
  return prepared.accessToken;
}

/**
 * Signs a session's tokens and binds the refresh token to a new family in
 * Redis, without a cookie yet. A route can run it inside a database
 * transaction, before the commit: if Redis fails, the change rolls back; if
 * the commit fails, the session carries a security version that never
 * committed, so it is refused at once.
 */
export async function prepareSession(
  config: AppConfig,
  refreshTokens: RefreshTokenRotationService,
  identity: SessionIdentity
): Promise<{ accessToken: string; refreshToken: string }> {
  const sessionClaims = {
    amr: identity.amr,
    auth_time: Math.floor(Date.now() / 1000),
    ...(identity.securityVersion === undefined ? {} : { sv: identity.securityVersion })
  };
  const refreshTokenId = uuidv7();
  const refreshFamilyId = uuidv7();
  const accessToken = await signAccessToken(config, {
    sub: identity.userId,
    tid: identity.tenantId,
    role: identity.role,
    email: identity.email,
    fid: refreshFamilyId,
    ...sessionClaims
  });

  const refreshToken = await signRefreshToken(config, {
    sub: identity.userId,
    tid: identity.tenantId,
    jti: refreshTokenId,
    fid: refreshFamilyId,
    ...sessionClaims
  });

  // Bind the jti to its family. Rotations stay within the same family so
  // we can detect refresh-token reuse (see lib/refresh-token-store.ts).
  await refreshTokens.issue({
    jti: refreshTokenId,
    familyId: refreshFamilyId
  });
  return { accessToken, refreshToken };
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  {
    db,
    config,
    auditEvents,
    limits,
    refreshTokens
  }: {
    /** Privileged pool: refresh runs before the tenant context exists. */
    db: Pool;
    config: AppConfig;
    auditEvents: AuditEventStore;
    limits?: RequestLimitsInterface;
    refreshTokens: RefreshTokenRotationService;
  }
): Promise<void> {
  // One statement on the privileged pool, outside a transaction; the SQL
  // keeps the tenant and user predicates. See PrivilegedAuthStateLookup.
  const authStates = new PrivilegedAuthStateLookup(db);

  // A refusal of /auth/refresh never deletes the refresh cookie. The cookie
  // jar is shared by every tab of the browser, and the Set-Cookie of an
  // answer applies when the answer arrives, not when this handler runs.
  // Another tab can get a newer cookie between the two: for example, an
  // enrolment that ends the older sessions, or a new sign-in. A deletion in
  // a refusal for the older cookie would then delete the newer one too. A
  // refused cookie can do no harm: its family is revoked or it is not valid,
  // so each later refresh with it gets a refusal again. Only an explicit
  // sign-out deletes the cookie (/auth/logout, /me/security/sessions/revoke).
  app.post("/auth/refresh", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) {
      return reply;
    }

    // The signature check comes first, because the limit needs the verified
    // family. It reads no store; the limit comes before every store read. A
    // limiter outage lets the request through. The claim below uses the same
    // Redis and answers 503 when it is down.
    const refreshToken = (request.cookies as Record<string, string>)?.[REFRESH_COOKIE_NAME];
    const payload = await verifiedRefreshToken(config, refreshToken);
    if (await enforceRateLimit(request, reply, limits, refreshRateLimitKey(request, payload))) return reply;
    if (!refreshToken) {
      return reply.code(401).send({ error: "missing_refresh_token" });
    }
    if (!payload) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }

    // The membership decides first, before the claim, so no answer below can
    // renew a session the request middleware would refuse. That includes the
    // cached result for a concurrent rotation, which returns before any other
    // database read. The token is untouched here, so a database failure is a
    // retryable 503, not a 401 that ends the session.
    let admission: ReturnType<typeof checkAuthAdmission>;
    try {
      admission = checkAuthAdmission(config, await authStates.getAuthState(payload.tid, payload.sub), {
        sv: payload.sv
      });
    } catch (error) {
      request.log.error({ err: error }, "auth refresh: membership lookup failed");
      reply.header("Retry-After", "1");
      return reply.code(503).send({ error: "refresh_unavailable" });
    }
    if (!admission.ok) {
      // End the session for good: without this, the same refresh token would
      // work again if the membership came back within its lifetime. If the
      // revoke fails, the family is still active, so a final 403 would be
      // false; answer 503, and the client's retry revokes. The cookie stays
      // (see above): a stale security version usually means that another tab
      // just started the session that replaces this one.
      try {
        await refreshTokens.revoke(payload.fid);
      } catch (error) {
        request.log.error({ err: error }, "auth refresh: family revoke failed after a refused membership");
        reply.header("Retry-After", "1");
        return reply.code(503).send({ error: "refresh_unavailable" });
      }
      return reply.code(403).send({ error: admission.error });
    }

    // Which side of the claim a throw lands on decides the response. After
    // the claim, the jti is already consumed: answering 401 makes the SPA drop
    // the session for what is usually a transient blip, and the client's retry
    // would later trip replay detection and revoke the whole family. So a
    // post-claim failure restores the jti and answers 503, which is retryable.
    let phase: "pre_claim" | "claimed" | "issued" = "pre_claim";
    let claimedJti: { jti: string; familyId: string } | null = null;

    try {
      const claim = await refreshTokens.claim({
        jti: payload.jti,
        familyId: payload.fid
      });

      if (claim.status === "completed") {
        return sendRefreshResult(reply, claim.result);
      }

      if (claim.status === "in_progress") {
        reply.header("Retry-After", "1");
        return reply.code(503).send({ error: "refresh_in_progress" });
      }

      if (claim.status === "reuse_detected") {
        // A jti from this family was replayed after rotation. Treat as
        // theft: revoke the entire family so the legitimate user is forced
        // back through login. The revoke comes before any answer: if it
        // fails, the catch below answers 503 with the family still active,
        // and the retry detects the reuse again. The cookie stays (see
        // above): a later replay gets the cheap `revoked` claim, with no
        // second detection.
        await refreshTokens.revoke(claim.familyId);
        request.log.warn(
          { userId: payload.sub, tenantId: payload.tid, familyId: claim.familyId },
          "auth refresh: reuse detected — revoking family"
        );
        await auditReuse(request, refreshTokens, auditEvents, claim.familyId, {
          tenantId: payload.tid,
          userId: payload.sub,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
          detectedAt: new Date().toISOString()
        });
        return reply.code(401).send({ error: "token_revoked" });
      }

      if (claim.status === "expired") {
        return reply.code(401).send({ error: "session_expired" });
      }

      if (claim.status === "revoked") {
        await auditKeptReuse(request, refreshTokens, auditEvents, payload.fid);
        return reply.code(401).send({ error: "token_revoked" });
      }

      phase = "claimed";
      claimedJti = { jti: payload.jti, familyId: claim.familyId };

      const user = await db.query(
        `SELECT email FROM users WHERE user_id = $1 LIMIT 1`,
        [payload.sub]
      );

      // The new tokens keep the sign-in facts of the session they renew. The
      // security version is the token's own, never the stored one: admission
      // above already proved they are equal.
      const sessionClaims = { amr: payload.amr, auth_time: payload.auth_time, sv: payload.sv };
      const accessToken = await signAccessToken(config, {
        sub: payload.sub,
        tid: payload.tid,
        role: admission.state.role,
        email: user.rows[0]?.email as string | undefined,
        fid: payload.fid,
        ...sessionClaims
      });

      // Issue a new refresh token with a new jti, keeping the same family.
      const newJti = uuidv7();
      const familyId = payload.fid;
      const newRefreshToken = await signRefreshToken(config, {
        sub: payload.sub,
        tid: payload.tid,
        jti: newJti,
        fid: familyId,
        ...sessionClaims
      });

      await refreshTokens.issue({
        jti: newJti,
        familyId
      });

      // Past this point the new token is live and the old jti must NOT be
      // restored — that would leave two valid jtis in one family.
      phase = "issued";

      const result = { accessToken, refreshToken: newRefreshToken };
      // Best-effort: `complete` only caches the result for concurrent callers
      // waiting on the grace marker. Failing to write that cache is not a
      // reason to fail a rotation that already succeeded — the tokens below
      // are valid either way.
      try {
        await refreshTokens.complete(payload.jti, result);
      } catch (error) {
        request.log.warn({ err: error }, "auth refresh: rotation result cache write failed");
      }
      return sendRefreshResult(reply, result);
    } catch (error) {
      if (phase === "claimed" && claimedJti) {
        // Best-effort. If the restore itself fails, the client falls back to
        // the grace-marker path (503 for 60s, then a family revoke) — bad,
        // but not worth turning into a 500 here.
        try {
          const restored = await refreshTokens.restore(claimedJti);
          if (!restored) {
            request.log.error(
              { jti: claimedJti.jti },
              "auth refresh: jti restore declined after a failed rotation"
            );
          }
        } catch (restoreError) {
          request.log.error(
            { err: restoreError, jti: claimedJti.jti },
            "auth refresh: jti restore failed after a failed rotation"
          );
        }
      }

      request.log.error({ err: error, phase }, "auth refresh: rotation failed");
      reply.header("Retry-After", "1");
      return reply.code(503).send({ error: "refresh_unavailable" });
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: false })) {
      return reply;
    }

    // The same limit as refresh: per verified family, or per client IP. A
    // limiter outage lets the sign-out through.
    const refreshToken = (request.cookies as Record<string, string>)?.[REFRESH_COOKIE_NAME];
    const verified = await verifiedRefreshToken(config, refreshToken);
    if (await enforceRateLimit(request, reply, limits, refreshRateLimitKey(request, verified))) return reply;

    // Revoke the entire refresh-token family so any rotated jti from the
    // same login chain becomes unusable. An expired or invalid token has no
    // family to revoke.
    if (verified) {
      try {
        await refreshTokens.revoke(verified.fid);
      } catch (error) {
        // The family is still active. Keep the cookie, so that the client
        // can retry. A 200 here would report a sign-out that did not occur.
        request.log.error({ err: error }, "auth logout: refresh-family revocation failed");
        reply.header("Retry-After", "1");
        return reply.code(503).send({ error: "logout_unavailable" });
      }
    }

    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });

  app.get("/auth/me", async (request, reply) => {
    if (!request.auth?.userId) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const user = await db.query(
      `SELECT u.user_id, u.email, u.display_name, tm.role, t.tenant_id, t.tenant_name, t.slug, t.login_type
       FROM users u
       JOIN tenant_memberships tm ON tm.user_id = u.user_id
       JOIN tenants t ON t.tenant_id = tm.tenant_id
       WHERE u.user_id = $1 AND tm.tenant_id = $2
       LIMIT 1`,
      [request.auth.userId, request.auth.tenantId]
    );

    if (!user.rows[0]) {
      return reply.code(404).send({ error: "user_not_found" });
    }

    const row = user.rows[0];
    return reply.send({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      tenantSlug: row.slug,
      role: row.role,
      // How this tenant's members sign in; the UI shows local account tools
      // only for "local".
      loginType: row.login_type
    });
  });
}
