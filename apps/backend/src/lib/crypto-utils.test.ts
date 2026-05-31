import { describe, expect, test } from "vitest";

import { computeConfigHash, decrypt, encrypt, sha256, unique } from "./crypto-utils.js";

// Envelope framing constants — mirrored from crypto-utils.ts. The layout is
// [ iv (12 bytes) | ciphertext (variable) | authTag (16 bytes) ], base64-encoded.
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// A >=32-char secret; AES-256 derives a 32-byte key via scrypt regardless, but
// callers are expected to pass real secrets of this length.
const SECRET = "test-secret-must-be-at-least-32-chars-long";

describe("encrypt / decrypt round-trip (AES-256-GCM)", () => {
  test("recovers ascii plaintext", () => {
    const plaintext = "hello world";
    expect(decrypt(encrypt(plaintext, SECRET), SECRET)).toBe(plaintext);
  });

  test("recovers unicode plaintext", () => {
    const plaintext = "héllo 🌍 — ünïcödé ✓ 日本語";
    expect(decrypt(encrypt(plaintext, SECRET), SECRET)).toBe(plaintext);
  });

  test("recovers the empty string", () => {
    expect(decrypt(encrypt("", SECRET), SECRET)).toBe("");
  });
});

describe("encrypt produces a well-formed envelope", () => {
  test("base64 payload is at least iv + tag in length", () => {
    const buf = Buffer.from(encrypt("", SECRET), "base64");
    // An empty plaintext still carries a 12-byte IV and a 16-byte auth tag.
    expect(buf.length).toBe(IV_LENGTH + TAG_LENGTH);
  });

  test("non-empty plaintext grows the ciphertext region by the byte length", () => {
    const plaintext = "abcdef";
    const buf = Buffer.from(encrypt(plaintext, SECRET), "base64");
    // GCM is a stream cipher: ciphertext length == plaintext byte length.
    expect(buf.length).toBe(IV_LENGTH + Buffer.byteLength(plaintext, "utf8") + TAG_LENGTH);
  });
});

describe("tamper detection (GCM authentication)", () => {
  test("flipping a byte in the ciphertext region makes decrypt throw", () => {
    const buf = Buffer.from(encrypt("sensitive-value", SECRET), "base64");
    // Pick a byte strictly inside the ciphertext region: [IV_LENGTH, len - TAG_LENGTH).
    const target = IV_LENGTH; // first ciphertext byte
    expect(target).toBeLessThan(buf.length - TAG_LENGTH);
    buf[target] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, SECRET)).toThrow();
  });

  test("flipping a byte in the auth-tag region makes decrypt throw", () => {
    const buf = Buffer.from(encrypt("sensitive-value", SECRET), "base64");
    // Pick a byte inside the tag region: [len - TAG_LENGTH, len).
    const target = buf.length - TAG_LENGTH; // first tag byte
    buf[target] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, SECRET)).toThrow();
  });

  test("flipping a byte in the IV region makes decrypt throw", () => {
    const buf = Buffer.from(encrypt("sensitive-value", SECRET), "base64");
    buf[0] ^= 0xff; // first IV byte
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, SECRET)).toThrow();
  });
});

describe("secret handling", () => {
  test("decrypting with a wrong / rotated secret throws", () => {
    const ciphertext = encrypt("rotate-me", SECRET);
    const rotatedSecret = "a-completely-different-secret-also-32-chars+";
    expect(() => decrypt(ciphertext, rotatedSecret)).toThrow();
  });
});

describe("IV uniqueness", () => {
  test("two encrypts of the same plaintext produce different outputs", () => {
    const plaintext = "same-input-every-time";
    const a = encrypt(plaintext, SECRET);
    const b = encrypt(plaintext, SECRET);
    // A random IV per call guarantees distinct envelopes; a static IV would
    // leak that the two values are identical.
    expect(a).not.toBe(b);
    // Both still decrypt back to the same plaintext.
    expect(decrypt(a, SECRET)).toBe(plaintext);
    expect(decrypt(b, SECRET)).toBe(plaintext);
  });

  test("the IV regions of two encrypts differ", () => {
    const a = Buffer.from(encrypt("x", SECRET), "base64").subarray(0, IV_LENGTH);
    const b = Buffer.from(encrypt("x", SECRET), "base64").subarray(0, IV_LENGTH);
    expect(a.equals(b)).toBe(false);
  });
});

describe("truncated envelope", () => {
  test("dropping trailing bytes (corrupting the tag) makes decrypt throw", () => {
    const buf = Buffer.from(encrypt("needs-full-tag", SECRET), "base64");
    const truncated = buf.subarray(0, buf.length - 1).toString("base64");
    expect(() => decrypt(truncated, SECRET)).toThrow();
  });

  test("an envelope shorter than iv + tag makes decrypt throw", () => {
    // Fewer than IV_LENGTH + TAG_LENGTH bytes cannot carry a valid frame.
    const tooShort = Buffer.alloc(IV_LENGTH + TAG_LENGTH - 1).toString("base64");
    expect(() => decrypt(tooShort, SECRET)).toThrow();
  });
});

describe("computeConfigHash", () => {
  test("is stable for equal input", () => {
    const config = { enabledTools: ["a", "b"], approvalPolicy: "require-approval" };
    expect(computeConfigHash(config)).toBe(computeConfigHash({ ...config }));
  });

  test("differs for different input", () => {
    const a = computeConfigHash({ enabledTools: ["a"] });
    const b = computeConfigHash({ enabledTools: ["b"] });
    expect(a).not.toBe(b);
  });

  test("returns a 64-char hex SHA-256 digest", () => {
    expect(computeConfigHash({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sha256", () => {
  test("is deterministic and distinguishes inputs", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).not.toBe(sha256("world"));
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("unique", () => {
  test("removes duplicate string values preserving first-seen order", () => {
    expect(unique(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("returns an empty array unchanged", () => {
    expect(unique([])).toEqual([]);
  });
});
