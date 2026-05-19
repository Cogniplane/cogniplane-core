import { test, expect } from "vitest";

import {
  Aes256GcmFindingEncryptor,
  PiiFindingEncryptionError,
  isEncryptedEnvelope
} from "./pii-finding-encryption.js";

const KEK_HEX = "0".repeat(64);
const ALT_KEK_HEX = "f".repeat(64);

test("encryptValue then decryptValue round-trips the original string", () => {
  const enc = new Aes256GcmFindingEncryptor(KEK_HEX);
  const envelope = enc.encryptValue("user@example.com", "tenant-a");
  expect(enc.decryptValue(envelope, "tenant-a")).toBe("user@example.com");
});

test("ciphertext for the same plaintext + tenant differs each call (random IV)", () => {
  const enc = new Aes256GcmFindingEncryptor(KEK_HEX);
  const a = enc.encryptValue("same-value", "tenant-a");
  const b = enc.encryptValue("same-value", "tenant-a");
  expect(a).not.toBe(b);
  expect(enc.decryptValue(a, "tenant-a")).toBe("same-value");
  expect(enc.decryptValue(b, "tenant-a")).toBe("same-value");
});

test("decrypt with the wrong tenantId fails (HKDF tenant isolation)", () => {
  const enc = new Aes256GcmFindingEncryptor(KEK_HEX);
  const envelope = enc.encryptValue("secret", "tenant-a");
  let err: unknown;
  try { enc.decryptValue(envelope, "tenant-b"); } catch (e) { err = e; }
  expect(err instanceof PiiFindingEncryptionError).toBeTruthy();
  expect((err as PiiFindingEncryptionError).code).toBe("pii_decrypt_failed");
});

test("decrypt with a different KEK fails", () => {
  const enc = new Aes256GcmFindingEncryptor(KEK_HEX);
  const envelope = enc.encryptValue("secret", "tenant-a");
  const enc2 = new Aes256GcmFindingEncryptor(ALT_KEK_HEX);
  let err: unknown;
  try { enc2.decryptValue(envelope, "tenant-a"); } catch (e) { err = e; }
  expect(err instanceof PiiFindingEncryptionError).toBeTruthy();
  expect((err as PiiFindingEncryptionError).code).toBe("pii_decrypt_failed");
});

test("tampered ciphertext fails decryption (GCM authTag validates integrity)", () => {
  const enc = new Aes256GcmFindingEncryptor(KEK_HEX);
  const envelope = enc.encryptValue("the-secret-value", "tenant-a");
  // Flip a character inside the ciphertext segment (parts[3]).
  const parts = envelope.split(":");
  const ct = parts[3]!;
  const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
  parts[3] = flipped;
  const tampered = parts.join(":");
  let err: unknown;
  try { enc.decryptValue(tampered, "tenant-a"); } catch (e) { err = e; }
  expect(err instanceof PiiFindingEncryptionError).toBeTruthy();
});

test("envelope shape: starts with enc:v1: and has 5 colon-separated segments", () => {
  const enc = new Aes256GcmFindingEncryptor(KEK_HEX);
  const envelope = enc.encryptValue("anything", "tenant-x");
  expect(envelope.startsWith("enc:v1:")).toBeTruthy();
  expect(envelope.split(":").length).toBe(5);
  expect(isEncryptedEnvelope(envelope)).toBeTruthy();
});

test("KEK shorter than 32 bytes throws at construction", () => {
  let err: unknown;
  try { new Aes256GcmFindingEncryptor("deadbeef"); } catch (e) { err = e; }
  expect(err instanceof PiiFindingEncryptionError).toBeTruthy();
  expect((err as PiiFindingEncryptionError).code).toBe("pii_kek_invalid");
});

test("KEK with non-hex characters throws at construction", () => {
  let err: unknown;
  try { new Aes256GcmFindingEncryptor("z".repeat(64)); } catch (e) { err = e; }
  expect(err instanceof PiiFindingEncryptionError).toBeTruthy();
  expect((err as PiiFindingEncryptionError).code).toBe("pii_kek_invalid");
});

test("decryptValue rejects envelopes missing the enc:v1: prefix", () => {
  const enc = new Aes256GcmFindingEncryptor(KEK_HEX);
  let err: unknown;
  try { enc.decryptValue("plaintext-not-encrypted", "tenant-a"); } catch (e) { err = e; }
  expect(err instanceof PiiFindingEncryptionError).toBeTruthy();
  expect((err as PiiFindingEncryptionError).code).toBe("pii_envelope_invalid");
});

test("decryptValue rejects envelopes with the wrong number of segments", () => {
  const enc = new Aes256GcmFindingEncryptor(KEK_HEX);
  let err: unknown;
  try { enc.decryptValue("enc:v1:onlyonepart", "tenant-a"); } catch (e) { err = e; }
  expect(err instanceof PiiFindingEncryptionError).toBeTruthy();
  expect((err as PiiFindingEncryptionError).code).toBe("pii_envelope_invalid");
});

test("isEncryptedEnvelope returns false for plain values and empty strings", () => {
  expect(isEncryptedEnvelope("")).toBe(false);
  expect(isEncryptedEnvelope("user@example.com")).toBe(false);
  expect(isEncryptedEnvelope("enc:v0:foo")).toBe(false);
});
