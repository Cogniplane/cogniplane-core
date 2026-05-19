import type { FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import { verifyRuntimeToken } from "../services/auth/runtime-token.js";
import { sanitizeUrl } from "./sanitize-url.js";

/**
 * Attempts to authenticate a request using a runtime token (rt_*).
 *
 * Runtime tokens are session-scoped, HMAC-signed tokens generated per
 * runtime session. They allow code running inside an E2B sandbox to call
 * back to the backend without holding a user JWT, and to authenticate
 * LLM calls through the /llm/anthropic and /llm/openai proxies without
 * ever seeing the real ANTHROPIC_API_KEY / OPENAI_API_KEY.
 *
 * Only applies to `/mcp/`, `/llm/anthropic/`, and `/llm/openai/` routes
 * — returns false for all other paths so normal auth continues.
 */
export function tryAuthenticateRuntimeToken(
  request: FastifyRequest,
  config: AppConfig
): boolean {
  const isMcp = request.url.startsWith("/mcp/");
  const isLlmAnthropic = request.url.startsWith("/llm/anthropic/");
  const isLlmOpenai = request.url.startsWith("/llm/openai/");
  if (!isMcp && !isLlmAnthropic && !isLlmOpenai) {
    return false;
  }

  // Order matters and varies by transport:
  //  - MCP (Codex Streamable HTTP): Authorization header is dropped on the
  //    initialize POST, so the token is in ?token=. Other RPCs use the
  //    header. We try header first, then query.
  //  - LLM/anthropic (Claude Agent SDK): the SDK sends `x-api-key` with
  //    whatever string we put in env.ANTHROPIC_API_KEY. For the proxy we
  //    put the rt_* token there. Some SDK code paths also accept
  //    `Authorization: Bearer`, so we keep that as a fallback.
  //  - LLM/openai (Codex CLI): Codex follows the OpenAI SDK convention
  //    and sends `Authorization: Bearer <key>`. The key comes from
  //    ~/.codex/auth.json (written by `codex login --with-api-key`).
  const authHeader = request.headers.authorization;
  const xApiKeyRaw = request.headers["x-api-key"];
  const xApiKey = Array.isArray(xApiKeyRaw) ? xApiKeyRaw[0] : xApiKeyRaw;
  let token: string | undefined;

  if (authHeader?.startsWith("Bearer rt_")) {
    token = authHeader.slice(7); // strip "Bearer "
  } else if (isLlmAnthropic && typeof xApiKey === "string" && xApiKey.startsWith("rt_")) {
    token = xApiKey;
  } else {
    const url = new URL(request.url, "http://localhost");
    const queryToken = url.searchParams.get("token");
    if (queryToken?.startsWith("rt_")) {
      token = queryToken;
    }
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
