import type { FastifyReply, FastifyRequest } from "fastify";

import type { LimitResource, RequestLimitsInterface } from "./request-limits.js";

/** One limiter call: the resource and the subject of each scope. */
export type RateLimitKey = { resource: LimitResource; userId: string; tenantId: string };

/**
 * The client IP. `request.ip` follows TRUST_PROXY (app.ts); without it, every
 * client behind a proxy has the proxy's address.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip || "unknown";
}

/** The client IP as the subject of both scopes, for a route with no verified identity. */
export function clientIpKey(resource: LimitResource, request: FastifyRequest): RateLimitKey {
  const ip = clientIp(request);
  return { resource, userId: ip, tenantId: ip };
}

/**
 * Counts one request against `key`. Returns `true` when the request is refused
 * (a 429 with Retry-After is written to `reply`, and the caller must stop),
 * `false` to continue. No limiter (test and dev wiring) allows.
 *
 * `failClosed`: when the limiter itself fails, answer 503 instead of letting
 * the request through. Credential endpoints (local password sign-in) use it,
 * because an unthrottled password check is the attack the limit exists for
 * (docs/architecture/local-accounts.md). The log line names the resource only,
 * never the subject.
 */
export async function enforceRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  limits: Pick<RequestLimitsInterface, "consumeRateLimit"> | undefined,
  key: RateLimitKey,
  options: { failClosed?: boolean } = {}
): Promise<boolean> {
  if (!limits) return false;

  let limiterFailed = false;
  const limitError = await limits.consumeRateLimit(key).catch((err: unknown) => {
    request.log.warn({ err, resource: key.resource }, "rate limiter unavailable");
    limiterFailed = true;
    return null;
  });
  if (limiterFailed && options.failClosed) {
    reply.code(503);
    reply.header("retry-after", "1");
    reply.send({ error: "rate_limiter_unavailable" });
    return true;
  }
  if (!limitError) return false;

  reply.code(429);
  reply.header("retry-after", Math.max(1, Math.ceil(limitError.retryAfterMs / 1000)));
  reply.send(limitError);
  return true;
}
