import { randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkOS } from "@workos-inc/node";

import { uuidv7 } from "../lib/uuid.js";

import type { AppConfig } from "../config.js";
import { isCorsOriginAllowed } from "../lib/cors.js";
import type { Pool } from "../lib/db.js";
import { withTransaction } from "../lib/db.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../lib/jwt.js";
import {
  consumeRefreshJti,
  issueRefreshJti,
  revokeRefreshFamily
} from "../lib/refresh-token-store.js";
import { getWorkOS } from "../lib/workos-client.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import { listIntegrationDescriptors } from "../services/integrations/integration-registry.js";

const REFRESH_COOKIE_NAME = "cogniplane_refresh";
const REFRESH_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

const OAUTH_STATE_COOKIE = "cogniplane_oauth_state";
const OAUTH_STATE_TTL_S = 600;
const OAUTH_PARAM_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function resolveTenantMembershipRole(input: {
  existingRole: string | null;
  isFirstMember: boolean;
  workosRoleSlug: string | null | undefined;
}): "owner" | "admin" | "member" {
  if (input.existingRole === "owner") {
    return "owner";
  }

  if (input.isFirstMember) {
    return "owner";
  }

  return input.workosRoleSlug === "admin" ? "admin" : "member";
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
    workos: injectedWorkos
  }: {
    db: Pool;
    config: AppConfig;
    auditEvents: AuditEventStore;
    /** Optional WorkOS instance — overrides the module-level singleton. Tests pass a stub. */
    workos?: WorkOS;
  }
): Promise<void> {
  // OAuth callback registration is delegated to each integration descriptor.
  // Bootstrap (`registerBuiltinIntegrations`) wires up the connection-service
  // handlers; private overlay descriptors can register their own callbacks
  // by setting `descriptor.oauthRoutes` and being registered before this
  // function runs.
  for (const descriptor of listIntegrationDescriptors()) {
    if (descriptor.oauthRoutes) {
      await descriptor.oauthRoutes.register(app);
    }
  }

  if (config.AUTH_MODE === "workos") {
    const workos = injectedWorkos ?? getWorkOS(config);

    app.get("/auth/login", async (request, reply) => {
      const { organization, connection } = request.query as Record<string, string | undefined>;

      if (organization !== undefined && !OAUTH_PARAM_PATTERN.test(organization)) {
        return reply.code(400).send({ error: "invalid_oauth_param", field: "organization" });
      }
      if (connection !== undefined && !OAUTH_PARAM_PATTERN.test(connection)) {
        return reply.code(400).send({ error: "invalid_oauth_param", field: "connection" });
      }

      const state = randomBytes(32).toString("base64url");

      reply.setCookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        maxAge: OAUTH_STATE_TTL_S
      });

      const authorizationUrl = workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: config.WORKOS_CLIENT_ID!,
        redirectUri: config.WORKOS_REDIRECT_URI!,
        state,
        ...(organization ? { organizationId: organization, prompt: "login" } : {}),
        ...(connection ? { connectionId: connection } : {})
      });

      return reply.send({ url: authorizationUrl });
    });

    app.post("/auth/callback", async (request, reply) => {
      const { code, state } = (request.body ?? {}) as { code?: string; state?: string };

      if (!code) {
        return reply.code(400).send({ error: "missing_code" });
      }

      const cookieState = (request.cookies as Record<string, string>)?.[OAUTH_STATE_COOKIE];
      // Always clear the state cookie — it's single-use regardless of outcome.
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });

      if (
        !state ||
        !cookieState ||
        !OAUTH_PARAM_PATTERN.test(state) ||
        !timingSafeEqualString(state, cookieState)
      ) {
        return reply.code(400).send({ error: "invalid_state" });
      }

      const authResponse = await workos.userManagement.authenticateWithCode({
        code,
        clientId: config.WORKOS_CLIENT_ID!
      });

      const workosUser = authResponse.user;

      // WorkOS types email as string | null; guard before inserting into DB.
      if (!workosUser.email) {
        return reply.code(403).send({ error: "email_required" });
      }

      const orgMemberships = await workos.userManagement.listOrganizationMemberships({
        userId: workosUser.id
      });

      // If the auth flow was initiated with a specific organization, prefer that one.
      const orgMembership = authResponse.organizationId
        ? orgMemberships.data.find((m) => m.organizationId === authResponse.organizationId)
        : orgMemberships.data[0];

      if (!orgMembership) {
        return reply.code(403).send({ error: "no_organization" });
      }

      const workosOrg = await workos.organizations.getOrganization(orgMembership.organizationId);

      // Wrap the entire user/tenant/membership upsert in a single transaction to
      // prevent race conditions in first-member owner promotion.
      const { tenantId, resolvedUserId, finalRole, previousRole } = await withTransaction(db, async (client) => {
        // Upsert tenant
        const tenantResult = await client.query(
          `INSERT INTO tenants (tenant_id, tenant_name, slug, workos_org_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (workos_org_id) DO UPDATE SET
             tenant_name = EXCLUDED.tenant_name,
             updated_at = NOW()
           RETURNING tenant_id`,
          [uuidv7(), workosOrg.name, workosOrg.id.toLowerCase(), workosOrg.id]
        );
        const tenantId = tenantResult.rows[0].tenant_id as string;

        // Upsert user
        const userId = uuidv7();
        const userResult = await client.query(
          `INSERT INTO users (user_id, email, display_name, workos_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (workos_user_id) DO UPDATE SET
             email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             updated_at = NOW()
           RETURNING user_id`,
          [
            userId,
            workosUser.email,
            `${workosUser.firstName ?? ""} ${workosUser.lastName ?? ""}`.trim(),
            workosUser.id
          ]
        );
        const resolvedUserId = userResult.rows[0].user_id as string;

        // Check member count before upserting membership — inside the same transaction
        // to prevent concurrent first-login races.
        const memberCount = await client.query(
          `SELECT COUNT(*) AS cnt FROM tenant_memberships WHERE tenant_id = $1`,
          [tenantId]
        );
        const isFirstMember = Number(memberCount.rows[0].cnt) === 0;

        const existingMembership = await client.query(
          `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
          [tenantId, resolvedUserId]
        );
        const previousRole = existingMembership.rows[0]?.role as string | undefined;
        const finalRole = resolveTenantMembershipRole({
          existingRole: previousRole ?? null,
          isFirstMember,
          workosRoleSlug: orgMembership.role?.slug
        });

        await client.query(
          `INSERT INTO tenant_memberships (tenant_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET
             role = EXCLUDED.role,
             updated_at = NOW()`,
          [tenantId, resolvedUserId, finalRole]
        );

        return { tenantId, resolvedUserId, finalRole, previousRole };
      });

      if (previousRole !== undefined && previousRole !== finalRole) {
        await auditEvents.create({
          tenantId,
          sessionId: null,
          userId: resolvedUserId,
          type: "role_changed",
          payload: { from: previousRole, to: finalRole },
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null
        });
      }

      const accessToken = await signAccessToken(config, {
        sub: resolvedUserId,
        tid: tenantId,
        role: finalRole,
        email: workosUser.email
      });

      const refreshTokenId = uuidv7();
      const refreshFamilyId = uuidv7();
      const refreshToken = await signRefreshToken(config, {
        sub: resolvedUserId,
        tid: tenantId,
        jti: refreshTokenId,
        fid: refreshFamilyId
      });

      // Bind the jti to its family. Rotations stay within the same family so
      // we can detect refresh-token reuse (see lib/refresh-token-store.ts).
      const redis = requireRefreshTokenStore(app);
      await issueRefreshJti(redis, {
        jti: refreshTokenId,
        familyId: refreshFamilyId,
        ttlSeconds: REFRESH_COOKIE_MAX_AGE_S
      });

      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        maxAge: REFRESH_COOKIE_MAX_AGE_S
      });

      return reply.send({
        accessToken,
        user: {
          userId: resolvedUserId,
          email: workosUser.email,
          displayName: `${workosUser.firstName ?? ""} ${workosUser.lastName ?? ""}`.trim(),
          tenantId,
          role: finalRole
        }
      });
    });

    app.post("/auth/refresh", async (request, reply) => {
      if (!passesCsrfOriginCheck(request, reply, config.API_ORIGIN)) {
        return reply;
      }

      const refreshToken = (request.cookies as Record<string, string>)?.[REFRESH_COOKIE_NAME];
      if (!refreshToken) {
        return reply.code(401).send({ error: "missing_refresh_token" });
      }

      try {
        const payload = await verifyRefreshToken(config, refreshToken);

        const redis = requireRefreshTokenStore(app);

        if (!payload.fid) {
          return reply.code(401).send({ error: "token_revoked" });
        }

        // Atomically consume the jti and detect replay against its family.
        const consumed = await consumeRefreshJti(redis, {
          jti: payload.jti,
          familyId: payload.fid,
          ttlSeconds: REFRESH_COOKIE_MAX_AGE_S
        });

        if (consumed.status === "reuse_detected") {
          // A jti from this family was replayed after rotation. Treat as
          // theft: revoke the entire family so the legitimate user is forced
          // back through login. Clear the cookie so the legitimate session
          // doesn't keep replaying the now-revoked token.
          await revokeRefreshFamily(redis, {
            familyId: consumed.familyId,
            ttlSeconds: REFRESH_COOKIE_MAX_AGE_S
          });
          request.log.warn(
            { userId: payload.sub, tenantId: payload.tid, familyId: consumed.familyId },
            "auth refresh: reuse detected — revoking family"
          );
          await auditEvents.create({
            tenantId: payload.tid,
            sessionId: null,
            userId: payload.sub,
            type: "auth.refresh_token_reuse_detected",
            payload: { familyId: consumed.familyId },
            ipAddress: request.ip,
            userAgent: request.headers["user-agent"] ?? null
          });
          reply.clearCookie(REFRESH_COOKIE_NAME, { path: "/" });
          return reply.code(401).send({ error: "token_revoked" });
        }

        if (consumed.status !== "ok") {
          // "revoked" or "not_found" — refuse without further action.
          return reply.code(401).send({ error: "token_revoked" });
        }

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

        await issueRefreshJti(redis, {
          jti: newJti,
          familyId,
          ttlSeconds: REFRESH_COOKIE_MAX_AGE_S
        });

        reply.setCookie(REFRESH_COOKIE_NAME, newRefreshToken, {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          path: "/",
          maxAge: REFRESH_COOKIE_MAX_AGE_S
        });

        return reply.send({ accessToken });
      } catch {
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }
    });

    app.post("/auth/logout", async (request, reply) => {
      if (!passesCsrfOriginCheck(request, reply, config.API_ORIGIN)) {
        return reply;
      }

      const refreshToken = (request.cookies as Record<string, string>)?.[REFRESH_COOKIE_NAME];

      // Revoke the entire refresh-token family so any rotated jti from the
      // same login chain becomes unusable. Legacy tokens (no fid) have no
      // family to revoke; the cookie is still cleared below.
      if (refreshToken) {
        try {
          const payload = await verifyRefreshToken(config, refreshToken);
          if (payload.fid) {
            const redis = requireRefreshTokenStore(app);
            await revokeRefreshFamily(redis, {
              familyId: payload.fid,
              ttlSeconds: REFRESH_COOKIE_MAX_AGE_S
            });
          }
        } catch {
          // If the token is already expired/invalid, nothing to revoke.
        }
      }

      reply.clearCookie(REFRESH_COOKIE_NAME, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
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
