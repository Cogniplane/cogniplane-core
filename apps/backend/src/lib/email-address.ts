// One form of an email address for local accounts: Unicode NFC, no
// surrounding spaces, lowercase. users.email_key applies lower(btrim()) in
// Postgres; the NFC step happens here, before the address is stored, so both
// agree. No provider-specific rules (no Gmail dot removal).
// See docs/ARCHITECTURE.md, "Authentication".

const MAX_EMAIL_LENGTH = 254;
// Deliberately loose: one @, something on each side, a dot in the domain, no
// spaces. The address is proven by the person who receives the setup link,
// not by a pattern. No address-list syntax or control characters either: a
// mail library reads `alice<attacker@example.test>` as a name and the address
// in the brackets, so email for this account would go to another mailbox.
const NOT_IN_ADDRESS = String.raw`\s@<>()[\]\\,;:"\u0000-\u001f\u007f`;
const EMAIL_SHAPE = new RegExp(`^[^${NOT_IN_ADDRESS}]+@[^${NOT_IN_ADDRESS}]+\\.[^${NOT_IN_ADDRESS}]+$`);

export function normalizeEmail(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/** The normalised address, or null when it is not usable as a sign-in name. */
export function parseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = normalizeEmail(raw);
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) return null;
  return email;
}
