import { test, expect } from "vitest";

import { signProxyHeaders, verifyProxyHeaders } from "./mcp-proxy-signature.js";

const SECRET = "test-secret-must-be-at-least-32-chars-long";
const baseInput = {
  userId: "user-1",
  sessionId: "session-1",
  runtimeId: "runtime-1",
  secret: SECRET
};

test("signProxyHeaders emits all five identity + signature headers", () => {
  const headers = signProxyHeaders({ ...baseInput, now: () => 1700000000000 });
  expect(headers["X-Framework-User-Id"]).toBe("user-1");
  expect(headers["X-Framework-Session-Id"]).toBe("session-1");
  expect(headers["X-Framework-Runtime-Id"]).toBe("runtime-1");
  expect(headers["X-Framework-Timestamp"]).toBe("1700000000000");
  expect(headers["X-Framework-Signature"]).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("verifyProxyHeaders accepts a freshly signed bundle", () => {
  const now = () => 1700000000000;
  const headers = signProxyHeaders({ ...baseInput, now });
  const result = verifyProxyHeaders(asLowerCase(headers), SECRET, {
    maxAgeMs: 60_000,
    now
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.userId).toBe("user-1");
    expect(result.sessionId).toBe("session-1");
    expect(result.runtimeId).toBe("runtime-1");
  }
});

test("verifyProxyHeaders rejects tampered identity headers", () => {
  const now = () => 1700000000000;
  const headers = signProxyHeaders({ ...baseInput, now });
  const tampered = { ...asLowerCase(headers), "x-framework-user-id": "attacker" };
  const result = verifyProxyHeaders(tampered, SECRET, { maxAgeMs: 60_000, now });
  expect(result).toEqual({ ok: false, reason: "bad_signature" });
});

test("verifyProxyHeaders rejects wrong secret", () => {
  const now = () => 1700000000000;
  const headers = signProxyHeaders({ ...baseInput, now });
  const result = verifyProxyHeaders(asLowerCase(headers), "different-secret", {
    maxAgeMs: 60_000,
    now
  });
  expect(result).toEqual({ ok: false, reason: "bad_signature" });
});

test("verifyProxyHeaders rejects stale timestamps", () => {
  const headers = signProxyHeaders({ ...baseInput, now: () => 1700000000000 });
  const result = verifyProxyHeaders(asLowerCase(headers), SECRET, {
    maxAgeMs: 60_000,
    // 10 minutes later
    now: () => 1700000000000 + 10 * 60 * 1000
  });
  expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
});

test("verifyProxyHeaders rejects missing headers", () => {
  const result = verifyProxyHeaders({}, SECRET, { maxAgeMs: 60_000 });
  expect(result).toEqual({ ok: false, reason: "missing_header" });
});

test("verifyProxyHeaders rejects non-numeric timestamp", () => {
  const headers = signProxyHeaders({ ...baseInput, now: () => 1700000000000 });
  const broken = { ...asLowerCase(headers), "x-framework-timestamp": "not-a-number" };
  const result = verifyProxyHeaders(broken, SECRET, { maxAgeMs: 60_000 });
  expect(result).toEqual({ ok: false, reason: "missing_header" });
});

test("verifyProxyHeaders accepts canonical-cased header names too", () => {
  const now = () => 1700000000000;
  const headers = signProxyHeaders({ ...baseInput, now });
  // Pass headers as-is (canonical case) without lower-casing.
  const result = verifyProxyHeaders(
    headers as unknown as Record<string, string>,
    SECRET,
    { maxAgeMs: 60_000, now }
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
