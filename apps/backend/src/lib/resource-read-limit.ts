import type { FastifyReply, FastifyRequest } from "fastify";

import type { LimitExceededErrorPayload, RequestLimitsInterface } from "../services/request-limits.js";

/**
 * Count one call to a member read that does heavy work on each call: a PDF
 * text preview or an MCP App resource. All these routes use the same
 * `resource_read` counters for the authenticated user and tenant, so a client
 * cannot get more calls by moving between routes. Call it after input
 * validation and before any lookup.
 *
 * Over the limit, it sets status 429 and `retry-after` and returns the payload;
 * the caller returns it to Fastify. Otherwise it returns null. When the limit
 * store is down, `RequestLimitsUnavailableError` propagates to `handleAppError`,
 * which sends a 503.
 */
export async function consumeResourceRead(
  limits: Pick<RequestLimitsInterface, "consumeRateLimit">,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<LimitExceededErrorPayload | null> {
  const { userId, tenantId } = request.auth;
  const limited = await limits.consumeRateLimit({ resource: "resource_read", userId, tenantId });
  if (limited) {
    reply.code(429);
    reply.header("retry-after", Math.max(1, Math.ceil(limited.retryAfterMs / 1000)));
  }
  return limited;
}
