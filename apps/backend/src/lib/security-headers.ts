import type { FastifyInstance } from "fastify";

// Static security headers applied to every response. Exported as a single
// source of truth so the hijacked SSE path (which bypasses the onSend hook
// below) can set the identical set and the two can't drift. The per-request
// `X-Request-Id` is added separately by each caller.
export const STATIC_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["X-XSS-Protection", "0"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"],
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"]
];

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", (request, reply, _payload, done) => {
    for (const [name, value] of STATIC_SECURITY_HEADERS) {
      reply.header(name, value);
    }
    reply.header("X-Request-Id", request.id);
    done();
  });
}
