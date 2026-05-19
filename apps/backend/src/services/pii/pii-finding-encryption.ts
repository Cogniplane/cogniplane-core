import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Envelope format for an encrypted PII finding value:
//   enc:v1:<base64url(iv)>:<base64url(ciphertext)>:<base64url(authTag)>
//
// The `enc:v1:` prefix is a versioned discriminator. Future readers route on
// the version; a casual eyeball on the DB column sees opaque data rather than
// mistaking it for plaintext.
const ENVELOPE_PREFIX = "enc:v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;
const HKDF_INFO = "pii-finding-v1";

export interface PiiFindingEncryptor {
  encryptValue(plain: string, tenantId: string): string;
  decryptValue(envelope: string, tenantId: string): string;
}

export class PiiFindingEncryptionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PiiFindingEncryptionError";
    this.code = code;
  }
}

// AES-256-GCM with per-tenant DEK derived from a master KEK via HKDF-SHA256.
// Per-tenant derivation contains blast radius: a leaked DEK only exposes one
// tenant's findings, and it gives a future migration path to per-tenant KEK
// rotation without changing the ciphertext format.
export class Aes256GcmFindingEncryptor implements PiiFindingEncryptor {
  private readonly kek: Buffer;

  constructor(kekHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(kekHex)) {
      throw new PiiFindingEncryptionError(
        "pii_kek_invalid",
        "PII_RETENTION_KEK must be 32 bytes encoded as 64 hex characters"
      );
    }
    this.kek = Buffer.from(kekHex, "hex");
  }

  encryptValue(plain: string, tenantId: string): string {
    const dek = this.deriveDek(tenantId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      ENVELOPE_PREFIX.slice(0, -1),
      base64url(iv),
      base64url(ciphertext),
      base64url(authTag)
    ].join(":");
  }

  decryptValue(envelope: string, tenantId: string): string {
    if (!envelope.startsWith(ENVELOPE_PREFIX)) {
      throw new PiiFindingEncryptionError(
        "pii_envelope_invalid",
        "ciphertext envelope is missing the enc:v1: prefix"
      );
    }
    const parts = envelope.split(":");
    // ["enc", "v1", iv, ct, tag]
    if (parts.length !== 5) {
      throw new PiiFindingEncryptionError(
        "pii_envelope_invalid",
        "ciphertext envelope must split into exactly 5 colon-separated tokens (enc:v1:iv:ct:tag)"
      );
    }
    const iv = fromBase64url(parts[2]!);
    const ciphertext = fromBase64url(parts[3]!);
    const authTag = fromBase64url(parts[4]!);
    if (iv.length !== IV_BYTES) {
      throw new PiiFindingEncryptionError("pii_envelope_invalid", "iv length mismatch");
    }
    if (authTag.length !== AUTH_TAG_BYTES) {
      throw new PiiFindingEncryptionError("pii_envelope_invalid", "authTag length mismatch");
    }
    const dek = this.deriveDek(tenantId);
    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(authTag);
    try {
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString("utf8");
    } catch (error) {
      throw new PiiFindingEncryptionError(
        "pii_decrypt_failed",
        `decryption failed: ${error instanceof Error ? error.message : "unknown"}`
      );
    }
  }

  private deriveDek(tenantId: string): Buffer {
    const salt = Buffer.from(tenantId, "utf8");
    const dek = hkdfSync("sha256", this.kek, salt, Buffer.from(HKDF_INFO, "utf8"), KEY_BYTES);
    return Buffer.from(dek);
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64");
}

export function isEncryptedEnvelope(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}
