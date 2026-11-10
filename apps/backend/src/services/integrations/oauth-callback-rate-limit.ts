import type { FastifyReply, FastifyRequest } from "fastify";

import { clientIpKey, enforceRateLimit } from "../rate-limit-reply.js";
import type { RequestLimitsInterface } from "../request-limits.js";

/**
 * Throttle an unauthenticated integration OAuth callback (GitHub, Notion,
 * Microsoft) before it does any state verification or upstream token
 * exchange. The callback runs before any user context exists, so the only
 * source identifier available is the client IP: the `oauth_callback` limit
 * uses it for both the user and the tenant scope. Without this, forged-state
 * probes hit the verification path unthrottled, allowing brute-forcing of
 * state values. Sign-in has its own per-IP limit (`auth_sign_in`).
 *
 * Returns `true` if the request was throttled and the caller must stop. A
 * limiter outage lets the callback through: its state check still runs.
 * See `enforceRateLimit` for `failClosed`.
 */
export async function enforceOAuthCallbackRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  limits: Pick<RequestLimitsInterface, "consumeRateLimit"> | undefined,
  options: { failClosed?: boolean } = {}
): Promise<boolean> {
  return enforceRateLimit(request, reply, limits, clientIpKey("oauth_callback", request), options);
}
