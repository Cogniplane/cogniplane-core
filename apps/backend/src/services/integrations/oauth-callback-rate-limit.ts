import type { FastifyReply, FastifyRequest } from "fastify";

import type { RequestLimitsInterface } from "../request-limits.js";

/**
 * Throttle an unauthenticated OAuth callback before it does any state
 * verification or upstream token exchange. The callback runs before any user
 * context exists, so the only source identifier available is the client IP —
 * we key the shared `oauth_callback` limit on the IP for BOTH the user and
 * tenant scope (a per-IP bucket). Without this, forged-state probes hit the
 * verification path unthrottled, allowing brute-forcing of state values.
 *
 * Returns `true` if the request was throttled (a 429 has been written to
 * `reply` and the caller must stop), `false` to proceed. A missing limiter is
 * treated as "allow" so test/dev wiring without a limiter still works.
 */
export async function enforceOAuthCallbackRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  limits: RequestLimitsInterface | undefined
): Promise<boolean> {
  if (!limits) return false;

  const ip = request.ip || "unknown";
  const limitError = await limits.consumeRateLimit({
    resource: "oauth_callback",
    userId: ip,
    tenantId: ip
  });
  if (!limitError) return false;

  reply.code(429);
  reply.header("retry-after", Math.max(1, Math.ceil(limitError.retryAfterMs / 1000)));
  reply.send(limitError);
  return true;
}
