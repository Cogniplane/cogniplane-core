import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { WorkOS } from "@workos-inc/node";

import { type AppConfig, arePasskeysEnabled, isLoginTypeEnabled, isPasswordRecoveryEnabled } from "../config.js";
import { requireBrowserAuthOrigin } from "../lib/browser-auth-origin.js";
import type { Pool } from "../lib/db.js";
import { getWorkOS } from "../lib/workos-client.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import type { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import {
  provisionTenantIdentity,
  resolveWorkOsOrganization,
  WorkOsEmailConflictError,
  WrongLoginTypeError
} from "../services/auth/workos-tenant-provisioning.js";
import { IntegrationRegistry } from "../services/integrations/integration-registry.js";
import { clientIpKey, enforceRateLimit } from "../services/rate-limit-reply.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import type { RequestLimitsInterface } from "../services/request-limits.js";
import { registerLocalAuthRoutes } from "./auth-local.js";
import {
  createRefreshTokenRotationService,
  issueSession,
  REFRESH_COOKIE_PATH,
  registerSessionRoutes
} from "./auth-session.js";

const OAUTH_STATE_COOKIE = "cogniplane_oauth_state";
const OAUTH_PKCE_COOKIE = "cogniplane_oauth_pkce";
const OAUTH_STATE_TTL_S = 600;
const OAUTH_PARAM_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

type AuthRouteDeps = {
  /** Privileged pool in jwt mode: session routes run before tenant context. */
  db: Pool;
  /** app_user pool, for the tenant-scoped work of local accounts. */
  appDb?: Pool;
  /** Required when local login is enabled. */
  localAuth?: LocalAuth;
  config: AppConfig;
  auditEvents: AuditEventStore;
  limits?: RequestLimitsInterface;
  /** Optional WorkOS instance — overrides the module-level singleton. Tests pass a stub. */
  integrationDescriptors?: IntegrationRegistry;
  workos?: WorkOS;
};

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { config, integrationDescriptors = new IntegrationRegistry() } = deps;

  // Register callbacks from this app's integration services.
  for (const descriptor of integrationDescriptors.list()) {
    if (descriptor.oauthRoutes) {
      await descriptor.oauthRoutes.register(app);
    }
  }

  // Public in every mode: the login page reads it before anyone signs in.
  app.get("/auth/config", async () => ({
    mode: config.AUTH_MODE,
    loginTypes: [...config.AUTH_LOGIN_TYPES],
    // Self-service recovery sends a link by email.
    passwordRecovery: isPasswordRecoveryEnabled(config),
    passkeys: arePasskeysEnabled(config)
  }));

  switch (config.AUTH_MODE) {
    case "dev-headers":
      // Identity comes from request headers; there is no session to manage.
      return;
    case "jwt": {
      const refreshTokens = createRefreshTokenRotationService(app);
      await registerSessionRoutes(app, { ...deps, refreshTokens });
      if (isLoginTypeEnabled(config, "workos")) {
        registerWorkosAuthRoutes(app, { ...deps, refreshTokens, workos: deps.workos ?? getWorkOS(config) });
      }
      if (isLoginTypeEnabled(config, "local")) {
        if (!deps.localAuth || !deps.appDb) throw new Error("Local login is enabled but its services are not wired.");
        await registerLocalAuthRoutes(app, {
          db: deps.appDb,
          config,
          auditEvents: deps.auditEvents,
          limits: deps.limits,
          localAuth: deps.localAuth
        });
      }
      return;
    }
    default: {
      const unknownMode: never = config.AUTH_MODE;
      throw new Error(`Unknown AUTH_MODE: ${String(unknownMode)}`);
    }
  }
}

function registerWorkosAuthRoutes(
  app: FastifyInstance,
  {
    db,
    config,
    auditEvents,
    limits,
    refreshTokens,
    workos
  }: AuthRouteDeps & { refreshTokens: RefreshTokenRotationService; workos: WorkOS }
): void {
  // Sign-in steps count per client IP (`auth_sign_in`). A limiter outage lets
  // them through, as before; the state and PKCE checks still run.
  app.get("/auth/login", async (request, reply) => {
    if (await enforceRateLimit(request, reply, limits, clientIpKey("auth_sign_in", request))) return reply;

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
    // This route creates a session, so a hostile page must not be able to
    // post a code of its own and sign the victim in as someone else.
    if (!requireBrowserAuthOrigin(request, reply, config.API_ORIGIN, { requireJson: true })) {
      return reply;
    }
    if (await enforceRateLimit(request, reply, limits, clientIpKey("auth_sign_in", request))) return reply;

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
      if (error instanceof WrongLoginTypeError) {
        request.log.warn(
          { organizationId: organization.organizationId },
          "auth callback 403: the organization's tenant does not use WorkOS login"
        );
        return reply.code(403).send({ error: "wrong_login_type" });
      }
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

    const accessToken = await issueSession(reply, config, refreshTokens, {
      userId: identity.userId,
      tenantId: identity.tenantId,
      role: identity.role,
      email: workosUser.email,
      amr: ["workos"]
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
      `SELECT workos_user_id, auth_source FROM users WHERE user_id = $1 LIMIT 1`,
      [request.auth.userId]
    );
    // A user of another login path has no WorkOS organizations to list, and
    // must not make this route call WorkOS at all.
    if (userResult.rows[0]?.auth_source === "local") {
      return reply.code(403).send({ error: "login_type_not_allowed" });
    }
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
