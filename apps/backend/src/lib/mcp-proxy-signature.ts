// Signed identity headers for proxy MCP upstreams.
//
// The framework forwards (userId, sessionId, runtimeId) to upstream proxy MCP
// servers so they can scope authorization decisions. Without a signature an
// upstream that aggregates calls from multiple deployments cannot tell a
// legitimate framework request from a spoofed one. We add an HMAC-SHA256
// signature plus a timestamp so upstreams can verify origin and reject
// replays.
//
// Wire format (5 headers):
//   X-Framework-User-Id
//   X-Framework-Session-Id
//   X-Framework-Runtime-Id
//   X-Framework-Timestamp   — Unix milliseconds at signing time
//   X-Framework-Signature   — base64url HMAC-SHA256 over the canonical string
//
// Canonical string (newline-separated to avoid delimiter collisions):
//   `${userId}\n${sessionId}\n${runtimeId}\n${timestamp}`
//
// Secret: AppConfig.DATA_ENCRYPTION_SECRET. Upstreams that verify must hold
// the same value (deployment-time concern).

import { createHmac, timingSafeEqual } from "node:crypto";

const ALGORITHM = "sha256";

export type ProxySignatureInput = {
  userId: string;
  sessionId: string;
  runtimeId: string;
  secret: string;
  now?: () => number;
};

export type ProxySignedHeaders = {
  "X-Framework-User-Id": string;
  "X-Framework-Session-Id": string;
  "X-Framework-Runtime-Id": string;
  "X-Framework-Timestamp": string;
  "X-Framework-Signature": string;
};

function canonicalString(parts: {
  userId: string;
  sessionId: string;
  runtimeId: string;
  timestamp: string;
}): string {
  return [parts.userId, parts.sessionId, parts.runtimeId, parts.timestamp].join("\n");
}

function hmac(data: string, secret: string): string {
  return createHmac(ALGORITHM, secret).update(data).digest("base64url");
}

export function signProxyHeaders(input: ProxySignatureInput): ProxySignedHeaders {
  const timestamp = String((input.now ?? Date.now)());
  const signature = hmac(
    canonicalString({
      userId: input.userId,
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      timestamp
    }),
    input.secret
  );
  return {
    "X-Framework-User-Id": input.userId,
    "X-Framework-Session-Id": input.sessionId,
    "X-Framework-Runtime-Id": input.runtimeId,
    "X-Framework-Timestamp": timestamp,
    "X-Framework-Signature": signature
  };
}

export type VerifyProxyHeadersResult =
  | { ok: true; userId: string; sessionId: string; runtimeId: string }
  | { ok: false; reason: "missing_header" | "stale_timestamp" | "bad_signature" };

export type VerifyProxyHeadersOptions = {
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

export function verifyProxyHeaders(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  options: VerifyProxyHeadersOptions
): VerifyProxyHeadersResult {
  const userId = readHeader(headers, "X-Framework-User-Id");
  const sessionId = readHeader(headers, "X-Framework-Session-Id");
  const runtimeId = readHeader(headers, "X-Framework-Runtime-Id");
  const timestamp = readHeader(headers, "X-Framework-Timestamp");
  const signature = readHeader(headers, "X-Framework-Signature");
  if (!userId || !sessionId || !runtimeId || !timestamp || !signature) {
    return { ok: false, reason: "missing_header" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "missing_header" };
  }

  const now = (options.now ?? Date.now)();
  if (Math.abs(now - ts) > options.maxAgeMs) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = hmac(
    canonicalString({ userId, sessionId, runtimeId, timestamp }),
    secret
  );

  // Both base64url strings are the same length when secret/algorithm match,
  // but defend against length mismatch (malformed input) before timingSafeEqual.
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true, userId, sessionId, runtimeId };
}
