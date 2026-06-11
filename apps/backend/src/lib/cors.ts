/**
 * Methods the API serves cross-origin. Shared between the real app and the
 * test-helper app so the lists cannot drift (PATCH is used by message
 * feedback and policy rule editing).
 */
export const CORS_ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/**
 * Returns true when the request Origin exactly matches the configured allowed
 * origin. Used by both the @fastify/cors plugin and the manual SSE CORS path
 * (which bypasses the plugin because reply.hijack() is called first).
 */
export function isCorsOriginAllowed(requestOrigin: string | undefined, allowedOrigin: string): boolean {
  return !!requestOrigin && requestOrigin === allowedOrigin;
}
