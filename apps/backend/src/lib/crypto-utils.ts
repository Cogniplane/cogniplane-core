import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

/**
 * Compute a SHA-256 hex digest of the JSON representation of the given value.
 * Used to produce deterministic config hashes for change detection.
 */
export function computeConfigHash(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/**
 * Compute a SHA-256 hex digest of an arbitrary string value.
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Return a new array with duplicate string values removed.
 */
export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
// Fixed salt — scrypt provides work factor; the salt just ensures the derived key
// is domain-separated from any other use of the same secret.
const KDF_SALT = Buffer.from("cogniplane-encryption-v1");

// Cache derived keys to avoid blocking the event loop on every encrypt/decrypt call.
// scryptSync with N=16384 takes ~40-100ms; caching amortizes this to once per unique secret.
const derivedKeyCache = new Map<string, Buffer>();

/**
 * Derive a 32-byte AES key from a passphrase using scrypt (N=16384, r=8, p=1).
 * Result is cached for the lifetime of the process.
 */
function deriveKey(secret: string): Buffer {
  const cached = derivedKeyCache.get(secret);
  if (cached) return cached;
  const key = scryptSync(secret, KDF_SALT, 32, { N: 16384, r: 8, p: 1 });
  derivedKeyCache.set(secret, key);
  return key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string: iv + ciphertext + authTag.
 */
export function encrypt(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 */
export function decrypt(encoded: string, secret: string): string {
  const key = deriveKey(secret);
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
