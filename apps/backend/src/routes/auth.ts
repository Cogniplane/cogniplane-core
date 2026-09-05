import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkOS } from "@workos-inc/node";

import { uuidv7 } from "../lib/uuid.js";

import type { AppConfig } from "../config.js";
import { isCorsOriginAllowed } from "../lib/cors.js";
import type { Pool } from "../lib/db.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../lib/jwt.js";
import type { RefreshRotationResult } from "../lib/refresh-token-store.js";
import { getWorkOS } from "../lib/workos-client.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import {
  provisionTenantIdentity,
  resolveWorkOsOrganization,
  WorkOsEmailConflictError
} from "../services/auth/workos-tenant-provisioning.js";
import { IntegrationRegistry } from "../services/integrations/integration-registry.js";
import { enforceOAuthCallbackRateLimit } from "../services/integrations/oauth-callback-rate-limit.js";
import type { RequestLimitsInterface } from "../services/request-limits.js";

const REFRESH_COOKIE_NAME = "cogniplane_refresh";
const REFRESH_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;
const REFRESH_COOKIE_PATH = "/auth";

const OAUTH_STATE_COOKIE = "cogniplane_oauth_state";
const OAUTH_PKCE_COOKIE = "cogniplane_oauth_pkce";
const OAUTH_STATE_TTL_S = 600;
const OAUTH_PARAM_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

function sendRefreshResult(reply: FastifyReply, result: RefreshRotationResult): FastifyReply {
  reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_COOKIE_MAX_AGE_S
  });
  return reply.send({ accessToken: result.accessToken });
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * CSRF guard for the cookie-only state-changing auth routes (`/auth/refresh`,
 * `/auth/logout`). The refresh cookie is `SameSite=None` (the frontend and
 * backend live on different domains), so the browser attaches it to cross-site
 * requests — meaning a malicious page could trigger a forced logout or an
 * unwanted token rotation. CORS stops the attacker from *reading* the response,
 * but not from *sending* the request, so these side-effects would still run.
 *
 * We reject any request whose `Origin` (or, as a fallback, `Referer`) header is
 * present but does not match the configured frontend origin. Requests with
 * neither header (non-browser / server-to-server callers) are allowed: a
 * cross-site page in a modern browser cannot suppress both headers on a
 * credentialed POST, so their absence means the request did not originate from a
 * forged browser context.
 *
 * Returns `true` when the request passed the check (or no check applied) and
 * `false` after it has written a 403 response.
 */
export function passesCsrfOriginCheck(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigin: string
): boolean {
  const origin = request.headers.origin;
  if (origin) {
    if (isCorsOriginAllowed(origin, allowedOrigin)) {
      return true;
    }
    reply.code(403).send({ error: "csrf_origin_mismatch" });
    return false;
  }

  const referer = request.headers.referer;
  if (referer) {
    let refererOrigin: string | undefined;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      refererOrigin = undefined;
    }
    if (refererOrigin && isCorsOriginAllowed(refererOrigin, allowedOrigin)) {
      return true;
    }
    reply.code(403).send({ error: "csrf_origin_mismatch" });
    return false;
  }

  return true;
}

function requireRefreshTokenStore(app: FastifyInstance) {
  if (!app.redis) {
    throw new Error("Redis is required for WorkOS refresh token revocation.");
  }

  return app.redis;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  {
    db,
    config,
    auditEvents,
    limits,
    integrationDescriptors = new IntegrationRegistry(),
    workos: injectedWorkos
  }: {
    db: Pool;
    config: AppConfig;
    auditEvents: AuditEventStore;
    limits?: RequestLimitsInterface;
    /** Optional WorkOS instance — overrides the module-level singleton. Tests pass a stub. */
    integrationDescriptors?: IntegrationRegistry;
    workos?: WorkOS;
  }
): Promise<void> {
  // Register callbacks from this app's integration services.
  for (const descriptor of integrationDescriptors.list()) {
    if (descriptor.oauthRoutes) {
      await descriptor.oauthRoutes.register(app);
    }
  }

  if (config.AUTH_MODE === "workos") {
    const workos = injectedWorkos ?? getWorkOS(config);
    const refreshTokens = new RefreshTokenRotationService(
      requireRefreshTokenStore(app),
      REFRESH_COOKIE_MAX_AGE_S
    );

    app.get("/auth/login", async (request, reply) => {
      if (await enforceOAuthCallbackRateLimit(request, reply, limits)) return reply;

      const { organization, connection } = request.query as Record<string, string | undefined>;

      if (organization !== undefined && !OAUTH_PARAM_PATTERN.test(organization)) {
        return reply.code(400).send({ error: "invalid_oauth_param", field: "organization" });
      }
      if (connection !== undefined && !OAUTH_PARAM_PATTERN.test(connection)) {
        return reply.code(400).send({ error: "invalid_oauth_param", field: "connection" });
      }

      const { url: authorizationUrl, state, codeVerifier } =
        await workos.userManagement.getAuthorizationUrlWithPKCE({
          provider: "authkit",
          clientId: config.WORKOS_CLIENT_ID!,
          redirectUri: config.WORKOS_REDIRECT_URI!,
          ...(organization ? { organizationId: organization, prompt: "login" } : {}),
          ...(connection ? { connectionId: connection } : {})
        });

      reply.setCookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        maxAge: OAUTH_STATE_TTL_S
      });
      reply.setCookie(OAUTH_PKCE_COOKIE, codeVerifier, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: REFRESH_COOKIE_PATH,
        maxAge: OAUTH_STATE_TTL_S
      });

      return reply.send({ url: authorizationUrl });
    });

    app.post("/auth/callback", async (request, reply) => {
      if (await enforceOAuthCallbackRateLimit(request, reply, limits)) return reply;

      const { code, state } = (request.body ?? {}) as { code?: string; state?: string };
      const cookieState = (request.cookies as Record<string, string>)?.[OAUTH_STATE_COOKIE];
      const codeVerifier = (request.cookies as Record<string, string>)?.[OAUTH_PKCE_COOKIE];
      // Always clear the flow cookies — both are single-use regardless of outcome.
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
      reply.clearCookie(OAUTH_PKCE_COOKIE, { path: REFRESH_COOKIE_PATH });

      if (!code) {
        return reply.code(400).send({ error: "missing_code" });
      }

      if (
        !state ||
        !cookieState ||
        !OAUTH_PARAM_PATTERN.test(state) ||
        !timingSafeEqualString(state, cookieState)
      ) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      if (!codeVerifier || !PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
        return reply.code(400).send({ error: "invalid_pkce_verifier" });
      }

      const authResponse = await workos.userManagement.authenticateWithCode({
        code,
        clientId: config.WORKOS_CLIENT_ID!,
        codeVerifier
      });

      const workosUser = authResponse.user;

      // WorkOS types email as string | null; guard before inserting into DB.
      if (!workosUser.email) {
        return reply.code(403).send({ error: "email_required" });
      }

      const organization = await resolveWorkOsOrganization(workos, {
        workosUserId: workosUser.id,
        organizationIdHint: authResponse.organizationId
      });

      if (organization.status === "selection_required") {
        return reply.code(409).send({
          error: "organization_selection_required",
          organizations: organization.organizations
        });
      }

      if (organization.status === "no_organization") {
        return reply.code(403).send({ error: "no_organization" });
      }

      const displayName = `${workosUser.firstName ?? ""} ${workosUser.lastName ?? ""}`.trim();
      let identity: Awaited<ReturnType<typeof provisionTenantIdentity>>;
      try {
        identity = await provisionTenantIdentity(db, {
          organizationId: organization.organizationId,
          organizationName: organization.organizationName,
          workosUserId: workosUser.id,
          email: workosUser.email,
          displayName,
          workosRoleSlug: organization.roleSlug
        });
      } catch (error) {
        // The email belongs to a different WorkOS identity. Answer 409 rather
        // than letting the unique violation surface as a 500. Both the typed
        // error and a raw 23505 are handled: a concurrent login can still lose
        // the race on the email constraint after our check.
        const isEmailConflict =
          error instanceof WorkOsEmailConflictError ||
          (error as { code?: string })?.code === "23505";
        if (!isEmailConflict) throw error;
        request.log.warn(
          { workosUserId: workosUser.id },
          "auth callback 409: email already bound to a different WorkOS identity"
        );
        return reply.code(409).send({ error: "email_in_use" });
      }

      if (identity.previousRole !== undefined && identity.previousRole !== identity.role) {
        await auditEvents.create({
          tenantId: identity.tenantId,
          sessionId: null,
          userId: identity.userId,
          type: "role_changed",
          payload: { from: identity.previousRole, to: identity.role },
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null
        });
      }

      // App RBAC is authoritative after provisioning (see
      // resolveTenantMembershipRole), so a WorkOS-side role change does not
      // propagate — including a revocation. Record the divergence so an
      // IdP-demoted user who still holds an elevated app role is visible in
      // the audit trail instead of silent. Owners are excluded: owner is an
      // app-level role WorkOS has no slug for.
      const idpRole = organization.roleSlug === "admin" ? "admin" : "member";
      if (identity.previousRole !== undefined && identity.role !== "owner" && identity.role !== idpRole) {
        await auditEvents.create({
          tenantId: identity.tenantId,
          sessionId: null,
          userId: identity.userId,
          type: "role_sync_divergence",
          payload: { appRole: identity.role, workosRoleSlug: organization.roleSlug ?? null },
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null
        });
      }

      const accessToken = await signAccessToken(config, {
        sub: identity.userId,
        tid: identity.tenantId,
        role: identity.role,
        email: workosUser.email
      });

      const refreshTokenId = uuidv7();
      const refreshFamilyId = uuidv7();
      const refreshToken = await signRefreshToken(config, {
        sub: identity.userId,
        tid: identity.tenantId,
        jti: refreshTokenId,
        fid: refreshFamilyId
      });

      // Bind the jti to its family. Rotations stay within the same family so
      // we can detect refresh-token reuse (see lib/refresh-token-store.ts).
      await refreshTokens.issue({
        jti: refreshTokenId,
        familyId: refreshFamilyId
      });

      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: REFRESH_COOKIE_PATH,
        maxAge: REFRESH_COOKIE_MAX_AGE_S
      });

      return reply.send({
        accessToken,
        user: {
          userId: identity.userId,
          email: workosUser.email,
          displayName,
          tenantId: identity.tenantId,
          role: identity.role
        }
      });
    });

    app.post("/auth/refresh", async (request, reply) => {
      if (!passesCsrfOriginCheck(request, reply, config.API_ORIGIN)) {
        return reply;
      }
      if (await enforceOAuthCallbackRateLimit(request, reply, limits)) return reply;

      const refreshToken = (request.cookies as Record<string, string>)?.[REFRESH_COOKIE_NAME];
      if (!refreshToken) {
        return reply.code(401).send({ error: "missing_refresh_token" });
      }

      // Which side of the claim a throw lands on decides the response. Before
      // the claim, the presented token is untouched and 401 is honest. After
      // it, the jti is already consumed: answering 401 makes the SPA drop the
      // session for what is usually a transient blip, and the client's retry
      // would later trip replay detection and revoke the whole family. So a
      // post-claim failure restores the jti and answers 503, which is
      // retryable.
      let phase: "pre_claim" | "claimed" | "issued" = "pre_claim";
      let claimedJti: { jti: string; familyId: string } | null = null;

      try {
        const payload = await verifyRefreshToken(config, refreshToken);

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
          // back through login. Clear the cookie so the legitimate session
          // doesn't keep replaying the now-revoked token.
          await refreshTokens.revoke(claim.familyId);
          request.log.warn(
            { userId: payload.sub, tenantId: payload.tid, familyId: claim.familyId },
            "auth refresh: reuse detected — revoking family"
          );
          await auditEvents.create({
            tenantId: payload.tid,
            sessionId: null,
            userId: payload.sub,
            type: "auth.refresh_token_reuse_detected",
            payload: { familyId: claim.familyId },
            ipAddress: request.ip,
            userAgent: request.headers["user-agent"] ?? null
          });
          reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
          return reply.code(401).send({ error: "token_revoked" });
        }

        if (claim.status === "expired") {
          reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
          return reply.code(401).send({ error: "session_expired" });
        }

        if (claim.status !== "claimed") {
          return reply.code(401).send({ error: "token_revoked" });
        }

        phase = "claimed";
        claimedJti = { jti: payload.jti, familyId: claim.familyId };

        const membership = await db.query(
          `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
          [payload.tid, payload.sub]
        );

        if (!membership.rows[0]) {
          return reply.code(403).send({ error: "not_a_member" });
        }

        const user = await db.query(
          `SELECT email FROM users WHERE user_id = $1 LIMIT 1`,
          [payload.sub]
        );

        const accessToken = await signAccessToken(config, {
          sub: payload.sub,
          tid: payload.tid,
          role: membership.rows[0].role as string,
          email: user.rows[0]?.email as string | undefined
        });

        // Issue a new refresh token with a new jti, keeping the same family.
        const newJti = uuidv7();
        const familyId = payload.fid;
        const newRefreshToken = await signRefreshToken(config, {
          sub: payload.sub,
          tid: payload.tid,
          jti: newJti,
          fid: familyId
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
        if (phase === "pre_claim") {
          return reply.code(401).send({ error: "invalid_refresh_token" });
        }

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

        request.log.error({ err: error, phase }, "auth refresh: rotation failed after claim");
        reply.header("Retry-After", "1");
        return reply.code(503).send({ error: "refresh_unavailable" });
      }
    });

    app.post("/auth/logout", async (request, reply) => {
      if (!passesCsrfOriginCheck(request, reply, config.API_ORIGIN)) {
        return reply;
      }
      if (await enforceOAuthCallbackRateLimit(request, reply, limits)) return reply;

      const refreshToken = (request.cookies as Record<string, string>)?.[REFRESH_COOKIE_NAME];

      // Revoke the entire refresh-token family so any rotated jti from the
      // same login chain becomes unusable.
      if (refreshToken) {
        try {
          const payload = await verifyRefreshToken(config, refreshToken);
          await refreshTokens.revoke(payload.fid);
        } catch {
          // If the token is already expired/invalid, nothing to revoke.
        }
      }

      reply.clearCookie(REFRESH_COOKIE_NAME, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: REFRESH_COOKIE_PATH
      });
      return reply.send({ ok: true });
    });

    app.get("/auth/me", async (request, reply) => {
      if (!request.auth?.userId) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const user = await db.query(
        `SELECT u.user_id, u.email, u.display_name, tm.role, t.tenant_id, t.tenant_name, t.slug
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
        role: row.role
      });
    });

    app.get("/auth/organizations", async (request, reply) => {
      if (!request.auth?.userId) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      // One WorkOS API call per membership below — unlimited, an authenticated
      // user can amplify backend→WorkOS traffic until WorkOS throttles the
      // whole deployment.
      if (limits) {
        const limitError = await limits.consumeRateLimit({
          resource: "auth_organizations",
          userId: request.auth.userId,
          tenantId: request.auth.tenantId
        });
        if (limitError) {
          reply.code(429);
          reply.header("retry-after", Math.max(1, Math.ceil(limitError.retryAfterMs / 1000)));
          return reply.send(limitError);
        }
      }

      const userResult = await db.query(
        `SELECT workos_user_id FROM users WHERE user_id = $1 LIMIT 1`,
        [request.auth.userId]
      );
      const workosUserId = userResult.rows[0]?.workos_user_id as string | undefined;
      if (!workosUserId) {
        return reply.send({ organizations: [] });
      }

      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId: workosUserId
      });
      const orgs = await Promise.all(
        memberships.data.map(async (m) => {
          const org = await workos.organizations.getOrganization(m.organizationId);
          return { id: org.id, name: org.name };
        })
      );

      return reply.send({ organizations: orgs });
    });
  }
}
