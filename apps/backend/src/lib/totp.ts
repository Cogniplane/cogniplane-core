import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Time-based one-time passwords for authenticator apps (RFC 6238 over the
// HOTP algorithm of RFC 4226): HMAC-SHA1, 6 digits, 30-second steps, one step
// of clock drift either way. These are the defaults every common app uses.
// See docs/ARCHITECTURE.md, "Authentication".

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
const SECRET_BYTES = 20;
const DRIFT_STEPS = 1;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 character.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 as authenticator apps expect it. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * The time step whose code matches, within one step of drift, or null. The
 * caller must store the step and refuse any step not greater than the last
 * one used, so a code works once.
 */
export function matchTotp(secretBase32: string, code: string, nowMs: number): number | null {
  const candidate = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(candidate)) return null;
  const secret = base32Decode(secretBase32);
  const now = totpStep(nowMs);
  let matched: number | null = null;
  // Check every step in the window, so the time taken does not show which one matched.
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step += 1) {
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(candidate)) && matched === null) matched = step;
  }
  return matched;
}

/** The link an authenticator app reads from the QR code. */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
