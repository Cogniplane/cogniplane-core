import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import { verifyAccessToken, isTokenExpiredError } from "./jwt.js";
import { tryAuthenticateRuntimeToken } from "./auth-runtime-token.js";
import { isPublicAuthPath } from "./auth-public-paths.js";
import { listIntegrationOAuthCallbackPaths } from "../services/integrations/integration-registry.js";
import { sanitizeUrl } from "./sanitize-url.js";
import type { TenantMemberStore } from "../services/tenant-member-store.js";

// Auth routes that are always public (login, refresh, logout). OAuth
// callback paths are pulled from the integration registry so a private
// overlay's integration descriptor can extend the allowlist without
// editing this file.
const STATIC_PUBLIC_AUTH_PATHS: readonly string[] = [
  "/auth/login",
  "/auth/callback",
  "/auth/refresh",
  "/auth/logout"
];

function buildPublicAuthPaths(): ReadonlySet<string> {
  return new Set<string>([...STATIC_PUBLIC_AUTH_PATHS, ...listIntegrationOAuthCallbackPaths()]);
}

export function workosAuth(config: AppConfig, tenantMembers: Pick<TenantMemberStore, "getRole">) {
  // Snapshot the allowlist at middleware-construction time. By this point
  // `registerBuiltinIntegrations` has run (called from `buildAppDependencies`),
  // so registry contents are stable.
  const publicAuthPaths = buildPublicAuthPaths();

  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    if (request.url === "/health") {
      return;
    }

    if (isPublicAuthPath(request.url, publicAuthPaths)) {
      return;
    }

    // Codex 0.120+ probes .well-known/oauth-authorization-server before connecting
    // to MCP servers. Return 404 (not 401) so Codex skips OAuth and falls back to
    // the static Bearer token from codex.toml / config.toml. Match against the
    // path component only, with startsWith — RFC 8615 places .well-known at the
    // root, and substring matching would 404 any URL whose query string happens
    // to contain "/.well-known/".
    const requestPath = request.url.split("?", 1)[0]!;
    if (requestPath.startsWith("/.well-known/")) {
      reply.code(404).send({ error: "not_found" });
      return;
    }

    // Runtime token authentication for MCP routes (Codex CLI → backend gateway)
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

      // Look up the user's role in this tenant. The store is constructed
      // against `privilegedDb` because tenant context isn't established yet
      // — admitting non-members is a tenant-spanning question.
      const role = await tenantMembers.getRole(payload.tid, payload.sub);
      if (!role) {
        request.log.warn(
          { url: sanitizeUrl(request.url), method: request.method, userId: payload.sub, tenantId: payload.tid },
          "auth 403: user is not a tenant member"
        );
        reply.code(403).send({ error: "not_a_member" });
        return;
      }

      request.auth = {
        userId: payload.sub,
        tenantId: payload.tid,
        email: payload.email,
        role,
        isAdmin: role === "owner" || role === "admin"
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
