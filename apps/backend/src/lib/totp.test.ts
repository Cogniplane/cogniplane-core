import { describe, expect, test } from "vitest";

import { base32Decode, base32Encode, matchTotp, otpauthUri, totpCode } from "./totp.js";
import { hashRecoveryCode, generateRecoveryCodes, isRecoveryCodeShape, normalizeRecoveryCode } from "./recovery-codes.js";

// RFC 6238, appendix B: SHA-1 with the ASCII secret "12345678901234567890".
// The RFC lists 8-digit codes; 6-digit codes are their last six digits.
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP", () => {
  test.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"]
  ])("matches the RFC 6238 vector at %i s", (seconds, expected) => {
    const step = Math.floor(seconds / 30);
    expect(totpCode(RFC_SECRET, step, 8)).toBe(expected);
    expect(totpCode(RFC_SECRET, step)).toBe(expected.slice(-6));
  });

  test("base32 round-trips and decodes what apps show", () => {
    const encoded = base32Encode(RFC_SECRET);
    expect(encoded).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, "$1 "))).toEqual(RFC_SECRET);
  });

  test("accepts one step of drift either way, and nothing further", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1111111111 * 1000;
    const step = Math.floor(1111111111 / 30);
    for (const offset of [-1, 0, 1]) {
      expect(matchTotp(secret, totpCode(RFC_SECRET, step + offset), now)).toBe(step + offset);
    }
    for (const offset of [-2, 2]) {
      expect(matchTotp(secret, totpCode(RFC_SECRET, step + offset), now)).toBeNull();
    }
  });

  test.each(["12345", "1234567", "abcdef", ""])("refuses the malformed code %j", (code) => {
    expect(matchTotp(base32Encode(RFC_SECRET), code, Date.now())).toBeNull();
  });

  test("builds the authenticator link", () => {
    const uri = otpauthUri({ issuer: "Cogniplane", account: "alice@example.com", secret: "ABC" });
    expect(uri).toBe("otpauth://totp/Cogniplane%3Aalice%40example.com?secret=ABC&issuer=Cogniplane&algorithm=SHA1&digits=6&period=30");
  });
});

describe("recovery codes", () => {
  const ROOT = "recovery-code-test-secret-at-least-32-chars";

  test("makes 10 distinct 80-bit codes, shown in groups of four", () => {
    const codes = generateRecoveryCodes(ROOT);
    expect(codes).toHaveLength(10);
    expect(new Set(codes.map((c) => c.code)).size).toBe(10);
    for (const { code, hash } of codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
      expect(hash).toBe(hashRecoveryCode(code, ROOT));
    }
  });

  test("hashes the typed code the same way, with spaces, dashes, or lowercase", () => {
    const [{ code, hash }] = generateRecoveryCodes(ROOT);
    expect(hashRecoveryCode(code.toLowerCase().replace(/-/g, " "), ROOT)).toBe(hash);
    expect(isRecoveryCodeShape(` ${code.toLowerCase()} `)).toBe(true);
    expect(normalizeRecoveryCode("ab-cd")).toBe("ABCD");
  });

  test("a different root secret gives a different hash", () => {
    const [{ code, hash }] = generateRecoveryCodes(ROOT);
    expect(hashRecoveryCode(code, `${ROOT}-rotated`)).not.toBe(hash);
  });
});
