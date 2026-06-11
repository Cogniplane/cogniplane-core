import type { FastifyRequest } from "fastify";

/**
 * Resolve the *origin* client IP for the egress controls (CIDR allowlist +
 * per-runtime IP pin in /llm and /mcp).
 *
 * The runtime (E2B sandbox) reaches the backend through a CDN-in-front-of-ALB
 * chain: sandbox → Cloudflare edge → ALB → backend. Cloudflare terminates the
 * sandbox's connection and opens a *new* one to the ALB from its own edge IP,
 * so the `X-Forwarded-For` address `trustProxy` resolves into `request.ip` is a
 * **Cloudflare edge IP**, not the sandbox. Cloudflare draws edge IPs from a
 * large rotating pool, so pinning `request.ip` pins a value that changes
 * per-request — the per-runtime pin then false-rejects the runtime's own later
 * calls (`egress_ip_mismatch`) while never actually pinning the sandbox.
 *
 * Cloudflare records the true origin client in `CF-Connecting-IP`. That IS the
 * sandbox's stable egress IP, which is exactly what the pin wants to bind to.
 * So when the request came through the trusted proxy chain, prefer that header;
 * otherwise fall back to `request.ip` (local dev, direct-ALB, or any topology
 * without Cloudflare).
 *
 * Spoof-safety: `CF-Connecting-IP` is honored ONLY when the request actually
 * traversed a trusted proxy hop — detected via `request.ips`, which Fastify
 * populates from `X-Forwarded-For` *after* validating it against `trustProxy`.
 * A single entry means no trusted hop was crossed (the value is just the raw
 * socket peer), so a client-supplied `CF-Connecting-IP` is ignored. This holds
 * the same trust boundary as `request.ip`: it is only as good as `TRUST_PROXY`
 * matching the real topology, and the ALB security group must admit Cloudflare
 * edge ranges only (otherwise the header is forgeable by hitting the ALB
 * directly). See docs/LEARNINGS.md.
 */
export function resolveEgressClientIp(request: FastifyRequest): string | null {
  // `request.ips` is only present when trustProxy is enabled; its first entry
  // is the socket peer and any further entries are trusted XFF hops. More than
  // one entry ⇒ the request crossed a trusted proxy, so CDN headers are
  // trustworthy.
  const crossedTrustedProxy = Array.isArray(request.ips) && request.ips.length > 1;
  if (crossedTrustedProxy) {
    const cfConnectingIp = request.headers["cf-connecting-ip"];
    const candidate = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return request.ip ?? null;
}
