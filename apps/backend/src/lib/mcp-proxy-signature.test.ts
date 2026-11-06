import { createHash } from "node:crypto";

import { test, expect } from "vitest";

import {
  DEFAULT_MAX_FUTURE_SKEW_MS,
  proxyServerSigningKey,
  signProxyHeaders,
  verifyProxyHeaders
} from "./mcp-proxy-signature.js";

const SECRET = "test-secret-must-be-at-least-32-chars-long";
const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" });
const NOW = 1700000000000;
const now = () => NOW;
const baseInput = {
  tenantId: "tenant-1",
  serverId: "server-a",
  userId: "user-1",
  sessionId: "session-1",
  runtimeId: "runtime-1",
  body: BODY,
  secret: SECRET
};
const KEY_A = proxyServerSigningKey(SECRET, { tenantId: "tenant-1", serverId: "server-a" });
const verifyOptions = { serverId: "server-a", maxAgeMs: 60_000, now };

test("signProxyHeaders emits the v2 identity + signature headers", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  expect(headers["X-Framework-Signature-Version"]).toBe("v2");
  expect(headers["X-Framework-Tenant-Id"]).toBe("tenant-1");
  expect(headers["X-Framework-Server-Id"]).toBe("server-a");
  expect(headers["X-Framework-User-Id"]).toBe("user-1");
  expect(headers["X-Framework-Session-Id"]).toBe("session-1");
  expect(headers["X-Framework-Runtime-Id"]).toBe("runtime-1");
  expect(headers["X-Framework-Timestamp"]).toBe(String(NOW));
  // 16 random bytes → 22 base64url characters (128 bits).
  expect(headers["X-Framework-Nonce"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(headers["X-Framework-Body-Sha256"]).toBe(
    createHash("sha256").update(BODY).digest("base64url")
  );
  expect(headers["X-Framework-Signature"]).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("signProxyHeaders uses a fresh nonce for each request", () => {
  const first = signProxyHeaders({ ...baseInput, now });
  const second = signProxyHeaders({ ...baseInput, now });
  expect(first["X-Framework-Nonce"]).not.toBe(second["X-Framework-Nonce"]);
  expect(first["X-Framework-Signature"]).not.toBe(second["X-Framework-Signature"]);
});

test("signProxyHeaders rejects a field that contains a newline", () => {
  expect(() => signProxyHeaders({ ...baseInput, userId: "user-1\nadmin", now })).toThrow(
    /newline/
  );
  expect(() => signProxyHeaders({ ...baseInput, tenantId: "t\n", now })).toThrow(/newline/);
});

test("verifyProxyHeaders accepts a freshly signed bundle and returns the nonce", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  const result = verifyProxyHeaders(asLowerCase(headers), BODY, KEY_A, verifyOptions);
  expect(result).toEqual({
    ok: true,
    tenantId: "tenant-1",
    serverId: "server-a",
    userId: "user-1",
    sessionId: "session-1",
    runtimeId: "runtime-1",
    nonce: headers["X-Framework-Nonce"],
    timestamp: NOW,
    keepNonceUntil: NOW + 60_000
  });
});

test("verifyProxyHeaders accepts the body as bytes", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  const result = verifyProxyHeaders(
    asLowerCase(headers),
    Buffer.from(BODY, "utf8"),
    KEY_A,
    verifyOptions
  );
  expect(result.ok).toBe(true);
});

test("the key for server A does not verify a request signed for server B", () => {
  const headersForB = signProxyHeaders({ ...baseInput, serverId: "server-b", now });
  const keyB = proxyServerSigningKey(SECRET, { tenantId: "tenant-1", serverId: "server-b" });
  expect(keyB).not.toBe(KEY_A);

  // Server A's key cannot verify B's request, even if A is told to expect B.
  expect(
    verifyProxyHeaders(asLowerCase(headersForB), BODY, KEY_A, {
      ...verifyOptions,
      serverId: "server-b"
    })
  ).toEqual({ ok: false, reason: "bad_signature" });
  // A request for B is refused by an upstream registered as A.
  expect(verifyProxyHeaders(asLowerCase(headersForB), BODY, KEY_A, verifyOptions)).toEqual({
    ok: false,
    reason: "wrong_server"
  });
  expect(
    verifyProxyHeaders(asLowerCase(headersForB), BODY, keyB, {
      ...verifyOptions,
      serverId: "server-b"
    }).ok
  ).toBe(true);
});

test("the same server ID in another tenant has a different key", () => {
  expect(proxyServerSigningKey(SECRET, { tenantId: "tenant-2", serverId: "server-a" })).not.toBe(
    KEY_A
  );
});

test("verifyProxyHeaders rejects a tampered body", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  const tamperedBody = BODY.replace("tools/call", "tools/list");
  expect(verifyProxyHeaders(asLowerCase(headers), tamperedBody, KEY_A, verifyOptions)).toEqual({
    ok: false,
    reason: "body_mismatch"
  });

  // Replacing the body hash header too still fails: the hash is signed.
  const rehashed = {
    ...asLowerCase(headers),
    "x-framework-body-sha256": createHash("sha256").update(tamperedBody).digest("base64url")
  };
  expect(verifyProxyHeaders(rehashed, tamperedBody, KEY_A, verifyOptions)).toEqual({
    ok: false,
    reason: "bad_signature"
  });
});

test("verifyProxyHeaders rejects a tampered tenant ID", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  const tampered = { ...asLowerCase(headers), "x-framework-tenant-id": "tenant-2" };
  expect(verifyProxyHeaders(tampered, BODY, KEY_A, verifyOptions)).toEqual({
    ok: false,
    reason: "bad_signature"
  });
});

test("verifyProxyHeaders rejects tampered identity headers", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  for (const name of ["x-framework-user-id", "x-framework-nonce", "x-framework-timestamp"]) {
    const tampered = {
      ...asLowerCase(headers),
      [name]: name === "x-framework-timestamp" ? String(NOW + 1) : "attacker"
    };
    expect(verifyProxyHeaders(tampered, BODY, KEY_A, verifyOptions)).toEqual({
      ok: false,
      reason: "bad_signature"
    });
  }
});

test("verifyProxyHeaders rejects the deployment-wide secret as the key", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  expect(verifyProxyHeaders(asLowerCase(headers), BODY, SECRET, verifyOptions)).toEqual({
    ok: false,
    reason: "bad_signature"
  });
});

test("verifyProxyHeaders rejects stale timestamps", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  const result = verifyProxyHeaders(asLowerCase(headers), BODY, KEY_A, {
    ...verifyOptions,
    // 10 minutes later
    now: () => NOW + 10 * 60 * 1000
  });
  expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
});

// Signs at `signedAt` and verifies at `verifiedAt` with maxAgeMs 60 s.
function verifyAt(
  signedAt: number,
  verifiedAt: number,
  extra: { maxFutureSkewMs?: number } = {}
) {
  const headers = signProxyHeaders({ ...baseInput, now: () => signedAt });
  return verifyProxyHeaders(asLowerCase(headers), BODY, KEY_A, {
    ...verifyOptions,
    ...extra,
    now: () => verifiedAt
  });
}

test("verifyProxyHeaders accepts the oldest timestamp inclusively", () => {
  expect(verifyAt(NOW, NOW + 60_000).ok).toBe(true);
  expect(verifyAt(NOW, NOW + 60_001)).toEqual({ ok: false, reason: "stale_timestamp" });
});

test("verifyProxyHeaders limits a future timestamp to the skew, not to maxAgeMs", () => {
  expect(DEFAULT_MAX_FUTURE_SKEW_MS).toBe(30_000);
  expect(verifyAt(NOW + 30_000, NOW).ok).toBe(true);
  expect(verifyAt(NOW + 30_001, NOW)).toEqual({ ok: false, reason: "future_timestamp" });
  // The old rule (|now - ts| <= maxAgeMs) accepted this.
  expect(verifyAt(NOW + 60_000, NOW)).toEqual({ ok: false, reason: "future_timestamp" });
  expect(verifyAt(NOW + 5_000, NOW, { maxFutureSkewMs: 5_000 }).ok).toBe(true);
  expect(verifyAt(NOW + 5_001, NOW, { maxFutureSkewMs: 5_000 })).toEqual({
    ok: false,
    reason: "future_timestamp"
  });
  expect(verifyAt(NOW + 1, NOW, { maxFutureSkewMs: 0 })).toEqual({
    ok: false,
    reason: "future_timestamp"
  });
});

test("keepNonceUntil is the last time at which the request is accepted", () => {
  // The framework clock is 30 s ahead of the upstream: the upstream receives
  // the request 30 s before its timestamp.
  const signedAt = NOW + 30_000;
  const headers = asLowerCase(signProxyHeaders({ ...baseInput, now: () => signedAt }));
  const at = (t: number) =>
    verifyProxyHeaders(headers, BODY, KEY_A, { ...verifyOptions, now: () => t });

  const first = at(NOW);
  if (!first.ok) throw new Error(`expected ok, got ${first.reason}`);
  expect(first.keepNonceUntil).toBe(signedAt + 60_000);

  // A nonce kept for maxAgeMs from receipt is gone at NOW + 60 s, but the
  // request is still accepted after that: this is the replay that the
  // keep-until time closes.
  expect(at(NOW + 60_001).ok).toBe(true);
  expect(at(first.keepNonceUntil).ok).toBe(true);
  expect(at(first.keepNonceUntil + 1)).toEqual({ ok: false, reason: "stale_timestamp" });
});

// Reference nonce store that follows the documented steps with one retention
// R for the store. The steps run synchronously, so each call is atomic.
// Negative controls: `sharedHighWater: false` uses only the caller's clock;
// `perVerifierRetention: true` uses each verifier's own keepNonceUntil.
function nonceStore({ sharedHighWater = true, retention = 60_000, perVerifierRetention = false } = {}) {
  const nonces = new Map<string, number>();
  let highWater = 0;
  return (headers: Record<string, string>, callerNow: number, maxAgeMs = 60_000): string => {
    const result = verifyProxyHeaders(headers, BODY, KEY_A, {
      ...verifyOptions,
      maxAgeMs,
      now: () => callerNow
    });
    if (!result.ok) return result.reason;
    const until = perVerifierRetention ? result.keepNonceUntil : result.timestamp + retention;
    const now = sharedHighWater ? Math.max(callerNow, highWater) : callerNow;
    highWater = now;
    if (until < now) return "stale_timestamp";
    for (const [nonce, entryUntil] of nonces) if (entryUntil < now) nonces.delete(nonce);
    if (nonces.has(result.nonce)) return "replay";
    nonces.set(result.nonce, until);
    return "accepted";
  };
}

const signedAtTime = (t: number) =>
  asLowerCase(signProxyHeaders({ ...baseInput, now: () => t }));

test("a store that follows the contract refuses every replay from one verifier", () => {
  for (const offset of [-60_000, -1, 0, 1, 30_000]) {
    const receive = nonceStore();
    const signedAt = NOW + offset;
    const headers = signedAtTime(signedAt);
    expect(receive(headers, NOW)).toBe("accepted");
    for (let t = NOW; t < signedAt + 60_000; t += 1_000) {
      expect(receive(headers, t)).toBe("replay");
    }
    expect(receive(headers, signedAt + 60_000)).toBe("replay");
    expect(receive(headers, signedAt + 60_001)).toBe("stale_timestamp");
    // The clock steps back. The stale request did not reach the store, so the
    // nonce is still held.
    expect(receive(headers, signedAt)).toBe("replay");
  }
});

test("a shared store refuses a replay from a verifier whose clock is far behind", () => {
  for (const sharedHighWater of [true, false]) {
    const receive = nonceStore({ sharedHighWater });
    const headers = signedAtTime(NOW);
    expect(receive(headers, NOW)).toBe("accepted");
    // Replica A runs fast; its next request makes the store delete the nonce.
    expect(receive(signedAtTime(NOW + 120_002), NOW + 120_002)).toBe("accepted");
    // Replica B is 90 s behind and still accepts the timestamp by its clock.
    const replay = receive(headers, NOW + 30_001);
    expect(replay).toBe(sharedHighWater ? "stale_timestamp" : "accepted");
  }
});

test("a shared store refuses a replay after all clocks step back together", () => {
  for (const sharedHighWater of [true, false]) {
    const receive = nonceStore({ sharedHighWater });
    const headers = signedAtTime(NOW);
    expect(receive(headers, NOW)).toBe("accepted");
    // All clocks pass the expiry, the nonce is deleted, then all step back.
    expect(receive(signedAtTime(NOW + 60_001), NOW + 60_001)).toBe("accepted");
    const replay = receive(headers, NOW + 30_000);
    expect(replay).toBe(sharedHighWater ? "stale_timestamp" : "accepted");
  }
});

test("a shared store refuses a replay through a verifier with a longer maxAgeMs", () => {
  for (const perVerifierRetention of [false, true]) {
    const receive = nonceStore({ retention: 120_000, perVerifierRetention });
    const headers = signedAtTime(NOW);
    expect(receive(headers, NOW, 60_000)).toBe("accepted");
    // Another request after 60 s deletes entries that a 60 s retention ends.
    expect(receive(signedAtTime(NOW + 60_001), NOW + 60_001, 60_000)).toBe("accepted");
    // A verifier with maxAgeMs 120 s still accepts the first timestamp.
    const replay = receive(headers, NOW + 60_002, 120_000);
    expect(replay).toBe(perVerifierRetention ? "accepted" : "replay");
  }
});

test("verifyProxyHeaders refuses a timestamp whose keep-until time is not a safe integer", () => {
  const top = Number.MAX_SAFE_INTEGER;
  const headers = asLowerCase(signProxyHeaders({ ...baseInput, now: () => top }));
  expect(
    verifyProxyHeaders(headers, BODY, KEY_A, { ...verifyOptions, maxAgeMs: 4, now: () => top })
  ).toEqual({ ok: false, reason: "missing_header" });
});

test("verifyProxyHeaders refuses invalid window options", () => {
  const headers = asLowerCase(signProxyHeaders({ ...baseInput, now }));
  for (const maxAgeMs of [0, -1, 0.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => verifyProxyHeaders(headers, BODY, KEY_A, { ...verifyOptions, maxAgeMs })).toThrow(
      /maxAgeMs/
    );
  }
  for (const maxFutureSkewMs of [-1, 0.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      verifyProxyHeaders(headers, BODY, KEY_A, { ...verifyOptions, maxFutureSkewMs })
    ).toThrow(/maxFutureSkewMs/);
  }
});

test("verifyProxyHeaders refuses a clock that returns no number", () => {
  // Signed long ago: a NaN clock must not turn off the timestamp check.
  const headers = asLowerCase(signProxyHeaders({ ...baseInput, now: () => 1 }));
  for (const bad of [Number.NaN, undefined, Number.POSITIVE_INFINITY]) {
    expect(() =>
      verifyProxyHeaders(headers, BODY, KEY_A, {
        ...verifyOptions,
        now: () => bad as unknown as number
      })
    ).toThrow(/now\(\)/);
  }
});

test("verifyProxyHeaders accepts only a decimal integer timestamp", () => {
  const headers = asLowerCase(signProxyHeaders({ ...baseInput, now }));
  for (const timestamp of [
    "1.7e12",
    ` ${NOW}`,
    `+${NOW}`,
    `0x${NOW.toString(16)}`,
    `${NOW}.0`,
    "",
    // 2^53: 16 digits, but not a safe integer.
    "9007199254740992",
    // 17 digits: above the length limit.
    "99999999999999999"
  ]) {
    const tampered = { ...headers, "x-framework-timestamp": timestamp };
    expect(verifyProxyHeaders(tampered, BODY, KEY_A, verifyOptions)).toEqual({
      ok: false,
      reason: "missing_header"
    });
  }
});

test("verifyProxyHeaders rejects missing headers", () => {
  expect(verifyProxyHeaders({}, BODY, KEY_A, verifyOptions)).toEqual({
    ok: false,
    reason: "missing_header"
  });
  const headers = asLowerCase(signProxyHeaders({ ...baseInput, now }));
  delete headers["x-framework-nonce"];
  expect(verifyProxyHeaders(headers, BODY, KEY_A, verifyOptions)).toEqual({
    ok: false,
    reason: "missing_header"
  });
});

test("verifyProxyHeaders rejects an unknown signature version", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  const v1 = { ...asLowerCase(headers), "x-framework-signature-version": "v1" };
  expect(verifyProxyHeaders(v1, BODY, KEY_A, verifyOptions)).toEqual({
    ok: false,
    reason: "unsupported_version"
  });
});

test("verifyProxyHeaders rejects non-numeric timestamp", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  const broken = { ...asLowerCase(headers), "x-framework-timestamp": "not-a-number" };
  expect(verifyProxyHeaders(broken, BODY, KEY_A, verifyOptions)).toEqual({
    ok: false,
    reason: "missing_header"
  });
});

test("verifyProxyHeaders accepts canonical-cased header names too", () => {
  const headers = signProxyHeaders({ ...baseInput, now });
  // Pass headers as-is (canonical case) without lower-casing.
  const result = verifyProxyHeaders(
    headers as unknown as Record<string, string>,
    BODY,
    KEY_A,
    verifyOptions
  );
  expect(result.ok).toBe(true);
});

// HTTP frameworks usually expose request headers lower-cased; signProxyHeaders
// emits canonical (Pascal-cased) names because we set them on the outbound
// request. The verifier should accept either case. Tests above mostly use the
// lower-cased form to mimic the upstream's `request.headers`.
function asLowerCase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}
