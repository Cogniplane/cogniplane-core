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
// when the operator sets it. It is never a value a v1 upstream held: anyone
// with the upstream signing secret can derive every per-server key. The HMAC key is the base64url text of the derived key (use its
// UTF-8 bytes).
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
// v1 (no tenant, server, nonce or body hash, one key for all upstreams) is
// removed. An upstream that verifies v1 must change to v2.

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "sha256";
const SIGNATURE_VERSION = "v2";
const NONCE_BYTES = 16;
const SERVER_KEY_BYTES = 32;

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
      /** Keep this value for maxAgeMs and reject a request that uses it again. */
      nonce: string;
      timestamp: number;
    }
  | {
      ok: false;
      reason:
        | "missing_header"
        | "unsupported_version"
        | "wrong_server"
        | "stale_timestamp"
        | "body_mismatch"
        | "bad_signature";
    };

export type VerifyProxyHeadersOptions = {
  /** The server ID that this upstream is registered as. */
  serverId: string;
  maxAgeMs: number;
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
 * This function does not detect replays by itself. On `ok: true` the upstream
 * must record `nonce` and keep it for at least `maxAgeMs`, and it must reject
 * a request whose nonce it already has. After `maxAgeMs` the timestamp check
 * rejects the request, so the upstream can then discard the nonce.
 */
export function verifyProxyHeaders(
  headers: Record<string, string | string[] | undefined>,
  body: string | Uint8Array,
  serverKey: string,
  options: VerifyProxyHeadersOptions
): VerifyProxyHeadersResult {
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

  const ts = Number(present.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "missing_header" };
  }
  const now = (options.now ?? Date.now)();
  if (Math.abs(now - ts) > options.maxAgeMs) {
    return { ok: false, reason: "stale_timestamp" };
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
    timestamp: ts
  };
}
