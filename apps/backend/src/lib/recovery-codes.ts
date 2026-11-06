import { createHmac, randomBytes } from "node:crypto";

import { DERIVED_SECRET_LABELS, deriveSecret } from "./derived-secrets.js";
import { base32Encode } from "./totp.js";

// One-time recovery codes for local accounts: 10 codes of 16 base32
// characters (80 bits), shown once as XXXX-XXXX-XXXX-XXXX. Stored as
// HMAC-SHA256 under a key derived from DATA_ENCRYPTION_SECRET, so a copy of
// the database alone does not allow offline guessing. When that secret
// changes, old codes stop working and users make new ones.
// See docs/ARCHITECTURE.md, "Authentication".

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_KEY_LABEL = DERIVED_SECRET_LABELS.recoveryCode;

function formatCode(raw: string): string {
  return raw.match(/.{4}/g)!.join("-");
}

/** The form that is hashed: no spaces or dashes, uppercase. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

export function isRecoveryCodeShape(input: string): boolean {
  return /^[A-Z2-7]{16}$/.test(normalizeRecoveryCode(input));
}

export function hashRecoveryCode(code: string, rootSecret: string): string {
  return createHmac("sha256", deriveSecret(rootSecret, RECOVERY_CODE_KEY_LABEL))
    .update(normalizeRecoveryCode(code))
    .digest("hex");
}

/** New codes for display, with their hashes for storage. */
export function generateRecoveryCodes(rootSecret: string): Array<{ code: string; hash: string }> {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(10));
    return { code: formatCode(raw), hash: hashRecoveryCode(raw, rootSecret) };
  });
}
