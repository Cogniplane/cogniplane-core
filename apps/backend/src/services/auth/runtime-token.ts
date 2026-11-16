import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Session-scoped runtime tokens allow the agent runtime to authenticate HTTP
 * requests back to the backend's MCP gateway without holding a real user JWT.
 *
 * Token format: `rt_<payload>.<signature>`
 *   payload = base64url(JSON.stringify({ jti, sid, tid, uid, rid, exp }))
 *   signature = HMAC-SHA256(payload, secret)
 *
 * The token is generated once per runtime session and sent as the
 * `Authorization: Bearer rt_...` header on every MCP gateway request.
 *
 * Every token requires an ISO 8601 UTC `exp` and nonblank string identities.
 * Callers set `exp` via `runtimeTokenExpiry(config.RUNTIME_TOKEN_TTL_MS)`.
 * Older tokens without an expiry are invalid, including during a deploy.
 *
 * The token is a bearer credential valid until `exp` — there is no revocation
 * deny-list. The leak window is bounded by two controls instead: the TTL, and
 * the MCP gateway's loopback-only admission (services/mcp/gateway-admission.ts),
 * which additionally requires the raw socket peer to be 127.0.0.1 or ::1, so a
 * leaked token is useless to anyone who cannot already run code on the backend
 * host. Every minted token carries a unique `jti` (token id) for audit/log
 * correlation.
 */

const TOKEN_PREFIX = "rt_";
const ALGORITHM = "sha256";

/**
 * Defensive size caps on the encoded token. Realistic payloads are ~150–200
 * bytes; these limits give comfortable headroom while preventing an attacker
 * from feeding an unbounded blob into `JSON.parse` via a future cache or
 * proxy that retains failed-verification tokens. HMAC verification already
 * gates parsing, so this is defense-in-depth.
 */
const MAX_TOKEN_LENGTH = 2048;
const MAX_PAYLOAD_LENGTH = 1024;

/**
 * Compute the `exp` claim for a runtime token. Callers pass `ttlMs` from
 * `config.RUNTIME_TOKEN_TTL_MS`. The token is minted once at workspace
 * bootstrap. Nothing refreshes it for the lifetime of the runtime, so the TTL
 * must outlive the longest realistic session. See the docstring on
 * `RUNTIME_TOKEN_TTL_MS` in config.ts for the trade-off.
 */
export function runtimeTokenExpiry(ttlMs: number, now: Date = new Date()): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

const identityClaimSchema = z.string().refine(value => value.trim().length > 0);
const runtimeTokenClaimsSchema = z.object({
  jti: identityClaimSchema,
  sid: identityClaimSchema,
  tid: identityClaimSchema,
  uid: identityClaimSchema,
  rid: identityClaimSchema,
  exp: z.iso.datetime()
});

export type RuntimeTokenClaims = z.infer<typeof runtimeTokenClaimsSchema>;

/** Claims a caller supplies at mint time. `jti` is auto-generated if omitted. */
export type RuntimeTokenMintClaims = Omit<RuntimeTokenClaims, "jti"> & { jti?: string };

function hmac(data: string, secret: string): string {
  return createHmac(ALGORITHM, secret).update(data).digest("base64url");
}

export function generateRuntimeToken(
  claims: RuntimeTokenMintClaims,
  secret: string
): string {
  const fullClaims = runtimeTokenClaimsSchema.parse({
    ...claims,
    jti: claims.jti === undefined ? randomUUID() : claims.jti
  });
  const payload = Buffer.from(JSON.stringify(fullClaims)).toString("base64url");
  const signature = hmac(payload, secret);
  return `${TOKEN_PREFIX}${payload}.${signature}`;
}

// This type separates `expired` from `invalid`, so callers can log or respond
// differently. An expired token is normal at the end of a long session, while
// `invalid` means malformed, tampered, or signed under a rotated secret.
export type RuntimeTokenVerification =
  | { kind: "valid"; claims: RuntimeTokenClaims }
  | { kind: "expired" }
  | { kind: "invalid" };

export function verifyRuntimeToken(
  token: string,
  secret: string
): RuntimeTokenVerification {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return { kind: "invalid" };
  }

  if (token.length > MAX_TOKEN_LENGTH) {
    return { kind: "invalid" };
  }

  const body = token.slice(TOKEN_PREFIX.length);
  const dotIndex = body.lastIndexOf(".");
  if (dotIndex === -1) {
    return { kind: "invalid" };
  }

  const payload = body.slice(0, dotIndex);
  const signature = body.slice(dotIndex + 1);

  if (payload.length > MAX_PAYLOAD_LENGTH || !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return { kind: "invalid" };
  }

  const expected = hmac(payload, secret);

  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(signature, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { kind: "invalid" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
  } catch {
    return { kind: "invalid" };
  }

  const parsed = runtimeTokenClaimsSchema.safeParse(decoded);
  if (!parsed.success) return { kind: "invalid" };
  const claims = parsed.data;
  if (Date.parse(claims.exp) <= Date.now()) return { kind: "expired" };

  return { kind: "valid", claims };
}
