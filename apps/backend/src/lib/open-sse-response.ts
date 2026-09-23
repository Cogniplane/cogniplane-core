import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCorsOriginAllowed } from "./cors.js";
import { STATIC_SECURITY_HEADERS } from "./security-headers.js";

export function openSseResponse(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): void {
  reply.hijack();
  // Hijacked replies bypass the CORS and security header hooks.
  const requestOrigin = request.headers.origin;
  if (requestOrigin && isCorsOriginAllowed(requestOrigin, app.config.API_ORIGIN)) {
    reply.raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
    reply.raw.setHeader("Vary", "Origin");
  }
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  for (const [name, value] of STATIC_SECURITY_HEADERS) {
    reply.raw.setHeader(name, value);
  }
  reply.raw.setHeader("X-Request-Id", request.id);
  reply.raw.setHeader("Cache-Control", "no-store, no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders();
}
