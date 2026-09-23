import { createHash } from "node:crypto";

import { test, expect } from "vitest";

import {
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
    timestamp: NOW
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
