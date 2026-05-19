/**
 * Returns true when the request Origin exactly matches the configured allowed
 * origin. Used by both the @fastify/cors plugin and the manual SSE CORS path
 * (which bypasses the plugin because reply.hijack() is called first).
 */
export function isCorsOriginAllowed(requestOrigin: string | undefined, allowedOrigin: string): boolean {
  return !!requestOrigin && requestOrigin === allowedOrigin;
}
