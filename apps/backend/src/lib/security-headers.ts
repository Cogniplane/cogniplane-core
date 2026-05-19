import type { FastifyInstance } from "fastify";

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", (request, reply, _payload, done) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-XSS-Protection", "0");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'"
    );
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    reply.header("X-Request-Id", request.id);
    done();
  });
}
