import type { FastifyReply, FastifyRequest } from "fastify";

import { isCorsOriginAllowed } from "./cors.js";

/**
 * CSRF guard for browser auth mutations: session creation (`/auth/callback`),
 * refresh, and logout. The refresh cookie is `SameSite=None`, because the
 * frontend and backend are on different sites, so the browser attaches it to
 * cross-site requests. CORS stops a hostile page from reading the response,
 * not from sending the request.
 *
 * `Origin` must be present and equal the frontend origin. A missing or `null`
 * Origin is refused: browsers send Origin on every POST, so its absence means
 * the caller is not the frontend.
 *
 * `requireJson` also refuses any body type other than JSON, so a hostile page
 * cannot use a form post. It is off for refresh and logout until every
 * deployed frontend sends a JSON body on them.
 *
 * Returns false after it writes a 403 or a 415.
 */
export function requireBrowserAuthOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigin: string,
  options: { requireJson: boolean }
): boolean {
  const origin = request.headers.origin;
  if (!origin || origin === "null" || !isCorsOriginAllowed(origin, allowedOrigin)) {
    reply.code(403).send({ error: "csrf_origin_mismatch" });
    return false;
  }

  const contentType = request.headers["content-type"];
  const isJson = typeof contentType === "string" && /^application\/json\s*(;|$)/i.test(contentType);
  if (options.requireJson ? !isJson : contentType !== undefined && !isJson) {
    reply.code(415).send({ error: "unsupported_media_type" });
    return false;
  }
  return true;
}
