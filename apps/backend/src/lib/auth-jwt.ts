import type { FastifyReply, FastifyRequest } from "fastify";

import { type AppConfig, arePasskeysEnabled, isLoginTypeEnabled, isPasswordRecoveryEnabled } from "../config.js";
import { verifyAccessToken, isTokenExpiredError } from "./jwt.js";
import { tryAuthenticateRuntimeToken } from "./auth-runtime-token.js";
import { checkAuthAdmission } from "./auth-admission.js";
import { isPublicAuthPath, isPublicDownloadRequest } from "./auth-public-paths.js";
import { listIntegrationOAuthCallbackPaths } from "../services/integrations/integration-registry.js";
import { sanitizeUrl } from "./sanitize-url.js";
import type { TenantMemberStore } from "../services/tenant-member-store.js";

// Session routes every login type uses. Refresh and logout read only the
// refresh cookie, so they must be reachable without an access token. The
// login page reads /auth/config before anyone signs in.
const SESSION_PUBLIC_AUTH_PATHS: readonly string[] = ["/auth/config", "/auth/refresh", "/auth/logout"];

// Local sign-in and the one-time links (routes/auth-local.ts). Public only
// when local login is enabled.
const LOCAL_PUBLIC_AUTH_PATHS: readonly string[] = [
  "/auth/local/login",
  "/auth/local/setup",
  "/auth/local/password/reset",
  "/auth/local/mfa/totp",
  "/auth/local/mfa/recovery",
  "/auth/local/enroll/totp/start",
  "/auth/local/enroll/totp/confirm"
];

// Public passkey ceremonies: passwordless sign-in, the second factor, and the
// sign-in enrolment. Public only when passkeys are on (WEBAUTHN_RP_ID).
const PASSKEY_PUBLIC_AUTH_PATHS: readonly string[] = [
  "/auth/passkey/login/options",
  "/auth/passkey/login/verify",
  "/auth/local/mfa/passkey/options",
  "/auth/local/mfa/passkey/verify",
  "/auth/local/enroll/passkey/options",
  "/auth/local/enroll/passkey/verify"
];

// Self-service password recovery sends a link by email. Public only when
// local login and email are on (SMTP_URL and MAIL_FROM).
const RECOVERY_PUBLIC_AUTH_PATHS: readonly string[] = ["/auth/local/password/forgot"];

// WorkOS sign-in routes. Public only when WorkOS login is enabled; otherwise
// they are not registered and must not be reachable without a token either.
const WORKOS_PUBLIC_AUTH_PATHS: readonly string[] = ["/auth/login", "/auth/callback"];

/**
 * OAuth callback paths come from the integration registry. A private overlay's
 * integration descriptor can extend the allowlist without editing this file.
 */
export function jwtPublicAuthPaths(
  config: Pick<AppConfig, "AUTH_MODE" | "AUTH_LOGIN_TYPES" | "WEBAUTHN_RP_ID" | "SMTP_URL" | "MAIL_FROM">,
  oauthCallbackPaths: readonly string[]
): Set<string> {
  return new Set([
    ...SESSION_PUBLIC_AUTH_PATHS,
    ...(isLoginTypeEnabled(config, "workos") ? WORKOS_PUBLIC_AUTH_PATHS : []),
    ...(isLoginTypeEnabled(config, "local") ? LOCAL_PUBLIC_AUTH_PATHS : []),
    ...(arePasskeysEnabled(config) ? PASSKEY_PUBLIC_AUTH_PATHS : []),
    ...(isPasswordRecoveryEnabled(config) ? RECOVERY_PUBLIC_AUTH_PATHS : []),
    ...oauthCallbackPaths
  ]);
}

/**
 * Request authentication for `AUTH_MODE=jwt`: a backend-issued access token in
 * `Authorization: Bearer`, whatever login type created the session.
 */
export function jwtAuth(
  config: AppConfig,
  tenantMembers: Pick<TenantMemberStore, "getAuthState">,
  oauthCallbackPaths: readonly string[] = listIntegrationOAuthCallbackPaths()
) {
  const publicAuthPaths = jwtPublicAuthPaths(config, oauthCallbackPaths);

  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    // Compare the path only — request.url includes any query string, so an
    // exact match would send a probe like /health?probe=1 through full auth.
    const pathname = request.url.split("?", 1)[0];
    if (pathname === "/health" || pathname === "/ready") {
      return;
    }

    if (isPublicAuthPath(request.url, publicAuthPaths) || isPublicDownloadRequest(request.method, request.url)) {
      return;
    }

    // Runtime token authentication for MCP routes (sandbox → backend gateway)
    if (tryAuthenticateRuntimeToken(request, config)) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      request.log.warn({ url: sanitizeUrl(request.url), method: request.method, hasAuthHeader: Boolean(authHeader) }, "auth 401: missing or malformed Authorization header");
      reply.code(401).send({ error: "missing_token" });
      return;
    }

    const token = authHeader.slice(7);
    try {
      const payload = await verifyAccessToken(config, token);

      // Look up the user's role and login type in this tenant. The caller must
      // build the store on `privilegedDb`, because no tenant context exists yet.
      const admission = checkAuthAdmission(config, await tenantMembers.getAuthState(payload.tid, payload.sub), {
        sv: payload.sv
      });
      if (!admission.ok) {
        request.log.warn(
          { url: sanitizeUrl(request.url), method: request.method, userId: payload.sub, tenantId: payload.tid, reason: admission.error },
          "auth 403: membership does not admit this token"
        );
        reply.code(403).send({ error: admission.error });
        return;
      }

      const { role, authSource, securityVersion } = admission.state;
      request.auth = {
        userId: payload.sub,
        tenantId: payload.tid,
        email: payload.email,
        role,
        isAdmin: role === "owner" || role === "admin",
        session: {
          familyId: payload.fid,
          authSource,
          ...(securityVersion === null ? {} : { securityVersion }),
          ...(payload.amr ? { amr: payload.amr } : {})
        }
      };
    } catch (err) {
      if (isTokenExpiredError(err)) {
        request.log.warn({ url: sanitizeUrl(request.url), method: request.method }, "auth 401: JWT expired");
        reply.code(401).send({ error: "token_expired" });
        return;
      }
      request.log.warn({ url: sanitizeUrl(request.url), method: request.method, err }, "auth 401: invalid JWT");
      reply.code(401).send({ error: "invalid_token" });
    }
  };
}
