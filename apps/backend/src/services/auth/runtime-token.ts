import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Session-scoped runtime tokens allow the Codex CLI (running inside an E2B
 * sandbox or local child process) to authenticate HTTP requests back to the
 * backend's MCP gateway without holding a real user JWT.
 *
 * Token format: `rt_<payload>.<signature>`
 *   payload = base64url(JSON.stringify({ sid, tid, uid, rid, exp? }))
 *   signature = HMAC-SHA256(payload, secret)
 *
 * The token is generated once per runtime session and embedded as an
 * Authorization header in the generated codex.toml MCP server entries.
 *
 * Production callers set `exp` via `runtimeTokenExpiry(config.RUNTIME_TOKEN_TTL_MS)`
 * to bound the leak window if a workspace file or sandbox snapshot is
 * captured. Default TTL is 1 hour; operators can shorten via the env var.
 * Verification still tolerates absence so older in-flight tokens keep
 * working through a deploy.
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
 * `config.RUNTIME_TOKEN_TTL_MS` (default 24 hours). The token is minted
 * once at workspace bootstrap and not refreshed for the lifetime of the
 * runtime, so the TTL must outlive the longest realistic session — see
 * the docstring on `RUNTIME_TOKEN_TTL_MS` in config.ts for the full
 * trade-off.
 */
export function runtimeTokenExpiry(ttlMs: number, now: Date = new Date()): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

export type RuntimeTokenClaims = {
  /** Session ID */
  sid: string;
  /** Tenant ID */
  tid: string;
  /** User ID */
  uid: string;
  /** Runtime ID */
  rid: string;
  /** Optional expiry (ISO 8601) */
  exp?: string;
};

function hmac(data: string, secret: string): string {
  return createHmac(ALGORITHM, secret).update(data).digest("base64url");
}

export function generateRuntimeToken(
  claims: RuntimeTokenClaims,
  secret: string
): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = hmac(payload, secret);
  return `${TOKEN_PREFIX}${payload}.${signature}`;
}

// Verification result. `expired` is distinguished from `invalid` so callers
// can log/respond differently — an expired token is operationally normal at
// the end of a long session, while `invalid` means malformed, tampered, or
// signed under a rotated secret.
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

  if (payload.length > MAX_PAYLOAD_LENGTH) {
    return { kind: "invalid" };
  }

  const expected = hmac(payload, secret);

  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(signature, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { kind: "invalid" };
  }

  let claims: RuntimeTokenClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as RuntimeTokenClaims;
  } catch {
    return { kind: "invalid" };
  }

  if (typeof claims.exp !== "undefined") {
    const expiresAt = new Date(claims.exp);
    if (Number.isNaN(expiresAt.getTime())) {
      return { kind: "invalid" };
    }
    if (expiresAt <= new Date()) {
      return { kind: "expired" };
    }
  }

  return { kind: "valid", claims };
}

/**
 * Returns the bearer token value for use in an Authorization header.
 */
export function runtimeTokenBearer(token: string): string {
  return `Bearer ${token}`;
}
