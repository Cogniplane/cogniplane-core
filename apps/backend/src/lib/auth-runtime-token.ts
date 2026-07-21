import type { FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import { verifyRuntimeToken } from "../services/auth/runtime-token.js";
import { sanitizeUrl } from "./sanitize-url.js";

/**
 * Attempts to authenticate a request using a runtime token (rt_*).
 *
 * Runtime tokens are session-scoped, HMAC-signed tokens generated per
 * runtime session. They allow the runtime's MCP client to call back to
 * the backend's /mcp gateway without holding a user JWT.
 *
 * Only applies to `/mcp/` routes — returns false for all other paths so
 * normal auth continues.
 */
export function tryAuthenticateRuntimeToken(
  request: FastifyRequest,
  config: AppConfig
): boolean {
  const isMcp = request.url.startsWith("/mcp/");
  if (!isMcp) {
    return false;
  }

  // MCP sends `Authorization: Bearer rt_...` on every request, including
  // initialize.
  const authHeader = request.headers.authorization;
  let token: string | undefined;

  if (authHeader?.startsWith("Bearer rt_")) {
    token = authHeader.slice(7); // strip "Bearer "
  }

  if (!token) {
    return false;
  }
  const result = verifyRuntimeToken(token, config.DATA_ENCRYPTION_SECRET);
  if (result.kind === "expired") {
    request.log.warn(
      { url: sanitizeUrl(request.url), method: request.method, reason: "runtime_token_expired" },
      "auth 401: runtime token (rt_) expired — session likely outlived RUNTIME_TOKEN_TTL_MS"
    );
    return false;
  }
  if (result.kind === "invalid") {
    request.log.warn(
      { url: sanitizeUrl(request.url), method: request.method, reason: "runtime_token_invalid" },
      "auth 401: runtime token (rt_) present but invalid (malformed, tampered, or signed under a rotated secret)"
    );
    return false;
  }

  request.auth = {
    userId: result.claims.uid,
    tenantId: result.claims.tid,
    isAdmin: false,
    role: "member"
  };

  return true;
}
