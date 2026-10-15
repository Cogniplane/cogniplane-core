import { describe, it, expect } from "vitest";
import {
  generateRuntimeToken,
  runtimeTokenExpiry,
  verifyRuntimeToken,
  type RuntimeTokenMintClaims
} from "./runtime-token.js";

const SECRET = "test-secret-must-be-at-least-32-characters-long!!";

function validClaims(): RuntimeTokenMintClaims {
  return {
    sid: "session-1",
    tid: "tenant-1",
    uid: "user-1",
    rid: "runtime-1",
    exp: new Date(Date.now() + 60_000).toISOString()
  };
}

describe("runtime token", () => {
  it("generates a token starting with rt_", () => {
    const token = generateRuntimeToken(validClaims(), SECRET);
    expect(token.startsWith("rt_")).toBeTruthy();
  });

  it("verifies a valid token and returns claims", () => {
    const claims = validClaims();
    const token = generateRuntimeToken(claims, SECRET);
    const result = verifyRuntimeToken(token, SECRET);
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.claims.sid).toBe(claims.sid);
    expect(result.claims.tid).toBe(claims.tid);
    expect(result.claims.uid).toBe(claims.uid);
    expect(result.claims.rid).toBe(claims.rid);
    expect(result.claims.exp).toBe(claims.exp);
  });

  it("verifies a token without an expiry", () => {
    const { exp: _exp, ...claims } = validClaims();
    const token = generateRuntimeToken(claims, SECRET);
    const result = verifyRuntimeToken(token, SECRET);
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.claims.sid).toBe(claims.sid);
    expect(result.claims.tid).toBe(claims.tid);
    expect(result.claims.uid).toBe(claims.uid);
    expect(result.claims.rid).toBe(claims.rid);
    expect(result.claims.exp).toBe(undefined);
  });

  it("rejects a token signed with a different secret as invalid", () => {
    const token = generateRuntimeToken(validClaims(), SECRET);
    const result = verifyRuntimeToken(token, "different-secret-also-32-chars-long!!");
    expect(result.kind).toBe("invalid");
  });

  it("returns kind=expired (distinct from invalid) for past-due tokens", () => {
    const claims = validClaims();
    claims.exp = new Date(Date.now() - 1000).toISOString();
    const token = generateRuntimeToken(claims, SECRET);
    const result = verifyRuntimeToken(token, SECRET);
    expect(result.kind).toBe("expired");
  });

  it("returns kind=invalid for a malformed exp value", () => {
    const claims = validClaims();
    claims.exp = "not-a-date";
    const token = generateRuntimeToken(claims, SECRET);
    const result = verifyRuntimeToken(token, SECRET);
    expect(result.kind).toBe("invalid");
  });

  it("rejects a token with a tampered payload as invalid", () => {
    const token = generateRuntimeToken(validClaims(), SECRET);
    // Tamper with a character in the payload (after rt_ prefix, before the dot)
    const tampered = token.slice(0, 4) + "X" + token.slice(5);
    const result = verifyRuntimeToken(tampered, SECRET);
    expect(result.kind).toBe("invalid");
  });

  it("rejects a token without the rt_ prefix as invalid", () => {
    const token = generateRuntimeToken(validClaims(), SECRET);
    const withoutPrefix = token.slice(3);
    const result = verifyRuntimeToken(withoutPrefix, SECRET);
    expect(result.kind).toBe("invalid");
  });

  it("rejects garbage input as invalid", () => {
    expect(verifyRuntimeToken("", SECRET).kind).toBe("invalid");
    expect(verifyRuntimeToken("rt_", SECRET).kind).toBe("invalid");
    expect(verifyRuntimeToken("rt_notbase64.alsonotbase64", SECRET).kind).toBe("invalid");
    expect(verifyRuntimeToken("Bearer some-jwt", SECRET).kind).toBe("invalid");
  });

  it("accepts a signed payload at the 1 KiB limit and rejects one just above it", () => {
    const claims = { ...validClaims(), jti: "fixed", sid: "" };
    const emptyLength = Buffer.byteLength(JSON.stringify(claims));
    // 768 JSON bytes encode to exactly 1024 base64url characters.
    const atLimit = generateRuntimeToken({ ...claims, sid: "s".repeat(768 - emptyLength) }, SECRET);
    const aboveLimit = generateRuntimeToken({ ...claims, sid: "s".repeat(769 - emptyLength) }, SECRET);
    expect(atLimit.slice(3).split(".")[0]).toHaveLength(1024);
    expect(aboveLimit.slice(3).split(".")[0]).toHaveLength(1026);
    expect(aboveLimit.length).toBeLessThan(2048);
    expect(verifyRuntimeToken(atLimit, SECRET).kind).toBe("valid");
    expect(verifyRuntimeToken(aboveLimit, SECRET).kind).toBe("invalid");
  });

  it("runtimeTokenExpiry adds the supplied TTL to the current time", () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    const oneHour = 60 * 60 * 1000;
    const expiry = runtimeTokenExpiry(oneHour, now);
    expect(expiry).toBe(new Date("2026-04-27T13:00:00.000Z").toISOString());
  });

  it("runtimeTokenExpiry honors a custom TTL override", () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    const thirtyMinutes = 30 * 60 * 1000;
    const expiry = runtimeTokenExpiry(thirtyMinutes, now);
    expect(expiry).toBe(new Date("2026-04-27T12:30:00.000Z").toISOString());
  });

  it("auto-generates a unique jti when none is supplied", () => {
    const t1 = generateRuntimeToken(validClaims(), SECRET);
    const t2 = generateRuntimeToken(validClaims(), SECRET);
    const r1 = verifyRuntimeToken(t1, SECRET);
    const r2 = verifyRuntimeToken(t2, SECRET);
    expect(r1.kind).toBe("valid");
    expect(r2.kind).toBe("valid");
    if (r1.kind === "valid" && r2.kind === "valid") {
      expect(r1.claims.jti).toBeTruthy();
      expect(r2.claims.jti).toBeTruthy();
      expect(r1.claims.jti).not.toBe(r2.claims.jti);
    }
  });

  it("preserves an explicitly supplied jti", () => {
    const token = generateRuntimeToken({ ...validClaims(), jti: "fixed-jti" }, SECRET);
    const result = verifyRuntimeToken(token, SECRET);
    expect(result.kind === "valid" && result.claims.jti).toBe("fixed-jti");
  });
});
