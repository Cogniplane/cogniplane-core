import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import { tryAuthenticateRuntimeToken } from "./auth-runtime-token.js";
import { isPublicAuthPath } from "./auth-public-paths.js";
import { listIntegrationOAuthCallbackPaths } from "../services/integrations/integration-registry.js";
import { sanitizeUrl } from "./sanitize-url.js";

// OAuth callback paths come from the integration registry so a private
// overlay's integration descriptor can extend the allowlist without
// editing this file.
function buildPublicAuthPaths(): ReadonlySet<string> {
  return new Set<string>(listIntegrationOAuthCallbackPaths());
}

export function localDevAuth(config: AppConfig) {
  const isProduction = process.env.NODE_ENV === "production";
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

    const header = request.headers["x-user-id"]?.toString();
    const userId = header || (isProduction ? undefined : config.LOCAL_DEV_USER_ID);
    const tenantId = request.headers["x-tenant-id"]?.toString() || (isProduction ? undefined : "local-dev-tenant");

    if (!userId || !tenantId) {
      request.log.warn({ url: sanitizeUrl(request.url), method: request.method, hasUserId: Boolean(header) }, "auth 401: missing X-User-Id or X-Tenant-Id header");
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const isAdmin = config.ADMIN_USER_IDS.includes(userId);
    request.auth = {
      userId,
      tenantId,
      isAdmin,
      role: isAdmin ? "owner" : "member"
    };
  };
}
