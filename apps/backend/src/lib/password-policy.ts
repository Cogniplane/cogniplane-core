// Password rules for local accounts (docs/ARCHITECTURE.md, "Authentication").
// NIST SP 800-63B-4: at least 15 characters when the password is the only
// factor, no composition rules, a block list. One rule for all accounts keeps
// it simple. Length counts Unicode code points after NFKC normalisation, which
// NIST asks for before hashing.

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@cogniplane/shared-types";

export type PasswordPolicyError = "password_too_short" | "password_too_long" | "password_too_common" | "password_contains_email";

// Common long passwords and keyboard runs. Short common passwords already fail
// the length rule, so the list only needs entries of 15 characters or more.
const BLOCKED = new Set([
  "passwordpassword", "password1234567", "password12345678", "password123456789",
  "123456789012345", "1234567890123456", "12345678901234567890", "098765432109876",
  "qwertyuiopasdfg", "qwertyuiopasdfgh", "qwertyuiopasdfghjkl", "qwertyuiop123456",
  "1qaz2wsx3edc4rfv", "1q2w3e4r5t6y7u8i", "zaq12wsxcde34rfv", "asdfghjklqwertyu",
  "iloveyouiloveyou", "letmeinletmein", "welcome12345678", "changemechangeme",
  "administrator123", "correcthorsebatterystaple", "abcdefghijklmnop", "aaaaaaaaaaaaaaa"
]);

/** The form that is measured, compared, and hashed. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

function isSingleRun(value: string): boolean {
  const chars = [...value];
  return chars.every((char) => char === chars[0]);
}

export function checkPasswordPolicy(password: string, context: { email?: string | null }): PasswordPolicyError | null {
  const normalized = normalizePassword(password);
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_LENGTH) return "password_too_short";
  if (length > PASSWORD_MAX_LENGTH) return "password_too_long";

  const lower = normalized.toLowerCase();
  const compact = lower.replace(/[\s._-]+/g, "");
  if (BLOCKED.has(lower) || BLOCKED.has(compact) || isSingleRun(compact)) return "password_too_common";

  const email = context.email?.trim().toLowerCase();
  if (email) {
    const localPart = email.split("@")[0] ?? "";
    if (compact.includes(email.replace(/[\s._-]+/g, "")) || (localPart.length >= 4 && compact.includes(localPart.replace(/[\s._-]+/g, "")))) {
      return "password_contains_email";
    }
  }
  return null;
}
