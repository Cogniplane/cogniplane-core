// Signed identity headers for proxy MCP upstreams (scheme v2).
//
// The framework sends tenant, server, user, session and runtime IDs to proxy
// MCP upstreams so that they can scope authorization decisions. The upstream
// uses the signature to make sure that the request comes from this framework,
// that nobody changed the IDs or the body, and that the request is not a
// replay.
//
// Wire format (10 headers):
//   X-Framework-Signature-Version — always `v2`
//   X-Framework-Tenant-Id
//   X-Framework-Server-Id
//   X-Framework-User-Id
//   X-Framework-Session-Id
//   X-Framework-Runtime-Id
//   X-Framework-Timestamp         — Unix milliseconds at signing time
//   X-Framework-Nonce             — 16 random bytes, base64url
//   X-Framework-Body-Sha256       — base64url SHA-256 of the exact body bytes sent
//   X-Framework-Signature         — base64url HMAC-SHA256 of the canonical string
//
// Canonical string: these nine values in this order, joined with "\n":
//   v2, tenantId, serverId, userId, sessionId, runtimeId, timestamp, nonce,
//   bodySha256
// No value can contain "\n". The signer throws and the verifier rejects.
//
// Key: one key for each (tenant, server) pair. `proxyServerSigningKey` derives
// it with HKDF-SHA256 from the upstream signing secret, with the tenant ID and
// the server ID in the HKDF info. The upstream signing secret is
// `proxySignatureSecret` in lib/derived-secrets.ts (HKDF of
// DATA_ENCRYPTION_SECRET under a v2 label), or MCP_UPSTREAM_SIGNING_ROOT_SECRET
// when the operator sets it. It is never a value that a v1 upstream held.
// Anyone with the upstream signing secret can derive every per-server key.
// The HMAC key is the base64url text of the derived key. Use its UTF-8 bytes.
//
// Give an upstream only its own per-server key. Never give it the upstream
// signing secret or the root secret. A per-server key cannot make a valid
// signature for a different server or tenant, and the root secret cannot be
// recovered from it. To get the key for one upstream, run in the backend:
//   proxyServerSigningKey(
//     proxySignatureSecret(DATA_ENCRYPTION_SECRET, MCP_UPSTREAM_SIGNING_ROOT_SECRET),
//     { tenantId, serverId }
//   )
// If you rotate MCP_UPSTREAM_SIGNING_ROOT_SECRET, all per-server keys change.
// Boot refuses the v1 override MCP_UPSTREAM_SIGNING_SECRET (config.ts).
//
// Replay: the upstream accepts a timestamp in [now - maxAgeMs,
// now + maxFutureSkewMs] and keeps each nonce until timestamp + maxAgeMs.
// See `verifyProxyHeaders` for the full contract.

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "sha256";
const SIGNATURE_VERSION = "v2";
const NONCE_BYTES = 16;
const SERVER_KEY_BYTES = 32;
export const DEFAULT_MAX_FUTURE_SKEW_MS = 30_000;
const TIMESTAMP_PATTERN = /^\d{1,16}$/;

// Protocol constants. If you change one, all per-server keys change.
const SERVER_KEY_SALT = Buffer.from("cogniplane-proxy-upstream-server-key-v2");
const SERVER_KEY_INFO_PREFIX = "cogniplane/v2/proxy-upstream-server-key";

export type ProxyServerKeyScope = {
  tenantId: string;
  serverId: string;
};

function assertNoNewline(fields: Record<string, string>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value.includes("\n")) {
      throw new Error(`Proxy signature field ${name} must not contain a newline.`);
    }
  }
}

/**
 * Derive the HMAC key for one (tenant, server) pair from the upstream signing
 * secret. Give the result to that upstream only.
 */
export function proxyServerSigningKey(
  upstreamSigningSecret: string,
  scope: ProxyServerKeyScope
): string {
  assertNoNewline({ tenantId: scope.tenantId, serverId: scope.serverId });
  const info = [SERVER_KEY_INFO_PREFIX, scope.tenantId, scope.serverId].join("\n");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(upstreamSigningSecret, "utf8"),
      SERVER_KEY_SALT,
      Buffer.from(info, "utf8"),
      SERVER_KEY_BYTES
    )
  ).toString("base64url");
}

export type ProxySignatureInput = {
  tenantId: string;
  serverId: string;
  userId: string;
  sessionId: string;
  runtimeId: string;
  /** The exact bytes that go on the wire. A string is hashed as UTF-8. */
  body: string | Uint8Array;
  /** The upstream signing secret. The per-server key is derived from it. */
  secret: string;
  now?: () => number;
};

export type ProxySignedHeaders = {
  "X-Framework-Signature-Version": string;
  "X-Framework-Tenant-Id": string;
  "X-Framework-Server-Id": string;
  "X-Framework-User-Id": string;
  "X-Framework-Session-Id": string;
  "X-Framework-Runtime-Id": string;
  "X-Framework-Timestamp": string;
  "X-Framework-Nonce": string;
  "X-Framework-Body-Sha256": string;
  "X-Framework-Signature": string;
};

type CanonicalParts = {
  tenantId: string;
  serverId: string;
  userId: string;
  sessionId: string;
  runtimeId: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
};

function canonicalString(parts: CanonicalParts): string {
  return [
    SIGNATURE_VERSION,
    parts.tenantId,
    parts.serverId,
    parts.userId,
    parts.sessionId,
    parts.runtimeId,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256
  ].join("\n");
}

function hmac(data: string, key: string): string {
  return createHmac(ALGORITHM, key).update(data).digest("base64url");
}

function bodySha256(body: string | Uint8Array): string {
  return createHash(ALGORITHM).update(body).digest("base64url");
}

export function signProxyHeaders(input: ProxySignatureInput): ProxySignedHeaders {
  const parts: CanonicalParts = {
    tenantId: input.tenantId,
    serverId: input.serverId,
    userId: input.userId,
    sessionId: input.sessionId,
    runtimeId: input.runtimeId,
    timestamp: String((input.now ?? Date.now)()),
    nonce: randomBytes(NONCE_BYTES).toString("base64url"),
    bodySha256: bodySha256(input.body)
  };
  assertNoNewline(parts);
  const key = proxyServerSigningKey(input.secret, {
    tenantId: input.tenantId,
    serverId: input.serverId
  });
  return {
    "X-Framework-Signature-Version": SIGNATURE_VERSION,
    "X-Framework-Tenant-Id": parts.tenantId,
    "X-Framework-Server-Id": parts.serverId,
    "X-Framework-User-Id": parts.userId,
    "X-Framework-Session-Id": parts.sessionId,
    "X-Framework-Runtime-Id": parts.runtimeId,
    "X-Framework-Timestamp": parts.timestamp,
    "X-Framework-Nonce": parts.nonce,
    "X-Framework-Body-Sha256": parts.bodySha256,
    "X-Framework-Signature": hmac(canonicalString(parts), key)
  };
}

export type VerifyProxyHeadersResult =
  | {
      ok: true;
      tenantId: string;
      serverId: string;
      userId: string;
      sessionId: string;
      runtimeId: string;
      /** Reject a later request that uses this value again. */
      nonce: string;
      timestamp: number;
      /**
       * Keep `nonce` until this time (Unix ms, inclusive): timestamp + maxAgeMs.
       * This is the last time at which the timestamp check accepts the request.
       */
      keepNonceUntil: number;
    }
  | {
      ok: false;
      reason:
        | "missing_header"
        | "unsupported_version"
        | "wrong_server"
        | "stale_timestamp"
        | "future_timestamp"
        | "body_mismatch"
        | "bad_signature";
    };

export type VerifyProxyHeadersOptions = {
  /** The server ID that this upstream is registered as. */
  serverId: string;
  /** How long after signing a request is accepted, in ms. A positive safe integer. */
  maxAgeMs: number;
  /**
   * How far a timestamp can be ahead of `now`, in ms: the allowed clock
   * difference between the framework and the upstream. A non-negative safe integer.
   * Default DEFAULT_MAX_FUTURE_SKEW_MS (30 s).
   *
   * To accept the same window as `maxAgeMs` during a rollout, set this to
   * `maxAgeMs`. This is safe only with the nonce store rule on
   * `verifyProxyHeaders`.
   */
  maxFutureSkewMs?: number;
  /** Unix ms. See the clock rules on `verifyProxyHeaders`. Default Date.now. */
  now?: () => number;
};

// Headers come from upstream HTTP frameworks lower-cased; accept both forms.
function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function safeEqual(expected: string, provided: string): boolean {
  // Both base64url strings are the same length when key/algorithm match,
  // but defend against length mismatch (malformed input) before timingSafeEqual.
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Verify v2 signed identity headers on the upstream side.
 *
 * `body` must be the raw request body bytes as received, before JSON parsing.
 * `serverKey` is the per-server key from `proxyServerSigningKey`.
 *
 * Timestamp rule: the timestamp header is Unix ms as 1 to 16 ASCII digits
 * (leading zeros allowed) with a value of at most 2^53 - 1, and
 * `timestamp + maxAgeMs` must also be at most 2^53 - 1. Otherwise the result
 * is `missing_header`. Accept the timestamp only if
 * `now - maxAgeMs <= timestamp <= now + maxFutureSkewMs`. Otherwise the result
 * is `stale_timestamp` or `future_timestamp`.
 *
 * This function does not detect replays by itself. On `ok: true` the upstream
 * must keep the nonce for as long as any of its verifiers can accept the
 * request again. Expiry by wall clock (for example a store TTL) cannot
 * guarantee this when clocks differ or go backward. After this function
 * returns `ok: true`, and only then, run these steps as one atomic operation
 * on the nonce store (a lock in one process; a transaction or a script in a
 * shared store). `R` is one retention value for the whole store, at least the
 * largest `maxAgeMs` of any verifier that uses it, and `until = timestamp + R`
 * (equal to `keepNonceUntil` when all verifiers use `maxAgeMs = R`):
 *
 * 1. `now = max(callerNow, highWater)`, then `highWater = now`. All verifiers
 *    share `highWater`, and it never goes backward.
 * 2. If `until < now`, reject the request as stale.
 * 3. Delete every entry whose `until < now`.
 * 4. If the store holds `nonce`, reject the request as a replay.
 * 5. Insert `nonce` with its `until`.
 *
 * An entry is deleted only after `highWater` passed its `until`, and step 2
 * then rejects every later request with that timestamp. This holds for any
 * clock difference or delay. The cost: when one clock runs fast, `highWater`
 * moves ahead, and the other verifiers reject requests as stale until their
 * clocks catch up.
 *
 * The rule also needs:
 * - A fixed `R` for the life of the store. A verifier can lower its
 *   `maxAgeMs` (to `R` or less) or change `maxFutureSkewMs` at any time.
 *   Raising `maxAgeMs` above `R` is not covered by this contract: a larger
 *   `R` can make a request valid again after its nonce was deleted.
 * - Durable state. The store must not lose a recorded nonce, and `highWater`
 *   must not go backward, also through restart and failover. A store that can
 *   lose them without notice (a cache without persistence, or Redis with
 *   asynchronous replication and failover) does not meet this contract.
 * - In Redis: one Lua script that gets `callerNow` and `until` as arguments,
 *   with `highWater` in one key and the nonces in a sorted set scored by
 *   `until`. Both keys must be in the same cluster hash slot. Do not depend on
 *   key expiry: it uses the Redis server's wall clock.
 *
 * Do not keep a nonce for `maxAgeMs` from the time of receipt. A timestamp
 * ahead of the upstream's clock stays valid after that time, and the request
 * can then be replayed. Changing this function does not change upstreams that
 * are already deployed: each one must change its own nonce retention.
 */
export function verifyProxyHeaders(
  headers: Record<string, string | string[] | undefined>,
  body: string | Uint8Array,
  serverKey: string,
  options: VerifyProxyHeadersOptions
): VerifyProxyHeadersResult {
  const maxFutureSkewMs = options.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  if (!(Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs > 0)) {
    throw new Error("verifyProxyHeaders: maxAgeMs must be a positive integer.");
  }
  if (!(Number.isSafeInteger(maxFutureSkewMs) && maxFutureSkewMs >= 0)) {
    throw new Error("verifyProxyHeaders: maxFutureSkewMs must be an integer, zero or more.");
  }
  const version = readHeader(headers, "X-Framework-Signature-Version");
  const parts = {
    tenantId: readHeader(headers, "X-Framework-Tenant-Id"),
    serverId: readHeader(headers, "X-Framework-Server-Id"),
    userId: readHeader(headers, "X-Framework-User-Id"),
    sessionId: readHeader(headers, "X-Framework-Session-Id"),
    runtimeId: readHeader(headers, "X-Framework-Runtime-Id"),
    timestamp: readHeader(headers, "X-Framework-Timestamp"),
    nonce: readHeader(headers, "X-Framework-Nonce"),
    bodySha256: readHeader(headers, "X-Framework-Body-Sha256")
  };
  const signature = readHeader(headers, "X-Framework-Signature");
  if (!version || !signature) {
    return { ok: false, reason: "missing_header" };
  }
  if (version !== SIGNATURE_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  for (const value of Object.values(parts)) {
    if (!value || value.includes("\n")) {
      return { ok: false, reason: "missing_header" };
    }
  }
  const present = parts as CanonicalParts;

  if (present.serverId !== options.serverId) {
    return { ok: false, reason: "wrong_server" };
  }

  // The signer writes String(Date.now()). Refuse other forms ("1e12", " 1",
  // "0x…") so that verifiers in other languages parse the same values.
  const ts = TIMESTAMP_PATTERN.test(present.timestamp) ? Number(present.timestamp) : Number.NaN;
  if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(ts + options.maxAgeMs)) {
    return { ok: false, reason: "missing_header" };
  }
  const now = (options.now ?? Date.now)();
  // A NaN `now` makes both comparisons false and accepts any timestamp.
  if (!Number.isFinite(now)) {
    throw new Error("verifyProxyHeaders: now() must return a finite number.");
  }
  if (ts < now - options.maxAgeMs) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (ts > now + maxFutureSkewMs) {
    return { ok: false, reason: "future_timestamp" };
  }

  if (!safeEqual(bodySha256(body), present.bodySha256)) {
    return { ok: false, reason: "body_mismatch" };
  }

  if (!safeEqual(hmac(canonicalString(present), serverKey), signature)) {
    return { ok: false, reason: "bad_signature" };
  }

  return {
    ok: true,
    tenantId: present.tenantId,
    serverId: present.serverId,
    userId: present.userId,
    sessionId: present.sessionId,
    runtimeId: present.runtimeId,
    nonce: present.nonce,
    timestamp: ts,
    keepNonceUntil: ts + options.maxAgeMs
  };
}
