import { timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import { tryAuthenticateRuntimeToken } from "./auth-runtime-token.js";
import { isPublicAuthPath, isPublicDownloadRequest } from "./auth-public-paths.js";
import { listIntegrationOAuthCallbackPaths } from "../services/integrations/integration-registry.js";
import { sanitizeUrl } from "./sanitize-url.js";

// Constant-time compare of a caller-supplied key against the configured one.
// Length is compared first because timingSafeEqual throws on a mismatch; key
// length is not a secret.
function matchesDevAuthKey(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function localDevAuth(config: AppConfig, oauthCallbackPaths: readonly string[] = listIntegrationOAuthCallbackPaths()) {
  const isProduction = process.env.NODE_ENV === "production";
  const publicAuthPaths = new Set(oauthCallbackPaths);
  // Set only when the operator disabled the loopback bind guard. Boot refuses
  // that opt-in without a key (config.ts), so this is non-null exactly when
  // identity headers can arrive from off-host.
  const devAuthKey = config.COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK
    ? config.DEV_HEADERS_AUTH_KEY
    : undefined;

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

    // Gate identity headers on the shared secret before trusting them.
    if (devAuthKey && !matchesDevAuthKey(devAuthKey, request.headers["x-dev-auth-key"]?.toString())) {
      request.log.warn(
        { url: sanitizeUrl(request.url), method: request.method },
        "auth 401: missing or invalid X-Dev-Auth-Key"
      );
      reply.code(401).send({ error: "unauthorized" });
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
