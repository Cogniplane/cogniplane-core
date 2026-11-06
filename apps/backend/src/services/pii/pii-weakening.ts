import type { PiiMode, PiiProtectionSettings, PiiRawRetention } from "@cogniplane/shared-types";

import type { PiiImportScopeRegistry } from "./pii-import-scopes.js";
import { type PiiPolicyActivation, resolvePiiPolicy } from "./pii-policy.js";

// When a PII save makes the protection weaker (docs/ARCHITECTURE.md, "Data
// routes"). Only such a save needs step-up and sends the owner notice: with a
// stolen admin token, a weaker policy sends unmasked personal data to the
// model provider, and the change stays after the victim signs out.
//
// Both policies are compared as the scan reads them (resolvePiiPolicy), so a
// stored policy that is not valid counts as what it does: content in scope is
// stopped. When protection was off, no save is weaker: nothing was scanned,
// and the admin who turns protection on later sees every field in the form.
// Otherwise a save is weaker when one of these fields becomes weaker:
// - Protection: on with a policy that is not valid (content in scope is
//   stopped) > on > off.
// - Mode: block > transform > detect. Block stops content with a finding;
//   transform sends it with the findings masked; detect sends it unmasked
//   and only reports. Off is the activation above.
// - A scope turned off: chat prompts, uploads, and every import scope key in
//   the stored policy or in the save, also a key that no overlay registers
//   now. The save accepts the legacy key `microsoftImports` without its
//   overlay and keeps every stored key that it does not name, so a value
//   that this deployment does not read applies when the overlay comes back.
//   Such a key with no stored value counts as on: an import that no source
//   registers is in scope, and the overlay's default is unknown here.
// - An entity type removed from the detectors.
// - Raw values kept: never > reversible_encrypted > admin_only (plain text
//   that admins can read).
// - Reports to admins turned off.
// - The detection model changed: another model can find less. The model's
//   address is platform configuration, not a tenant setting.
// `detectors.useRulesFirst` is not read by the scan: the rules always run
// first. A change of it is not weaker.
//
// The labels name the fields, never their values.

const ACTIVATION: Record<PiiPolicyActivation, number> = { off: 0, on: 1, invalid: 2 };
const MODE: Record<PiiMode, number> = { off: 0, detect: 1, transform: 2, block: 3 };
const RETENTION: Record<PiiRawRetention, number> = { admin_only: 0, reversible_encrypted: 1, never: 2 };
const CORE_SCOPE_LABELS: Record<string, string> = { chatPrompts: "Chat prompts", uploads: "Uploads" };

/** The raw `scopes` object of a policy as stored, or {} when it has none. */
function scopesOf(policy: unknown): Record<string, unknown> {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return {};
  const scopes = (policy as { scopes?: unknown }).scopes;
  return scopes && typeof scopes === "object" && !Array.isArray(scopes) ? scopes as Record<string, unknown> : {};
}

/**
 * The labels of the fields that a PII save makes weaker, in a fixed order.
 * Empty when the save makes nothing weaker. `stored`: the stored policy as
 * stored (not checked); `next`: the policy that the save stores.
 */
export function weakerPiiFields(
  stored: unknown,
  next: PiiProtectionSettings,
  registry: Pick<PiiImportScopeRegistry, "list">
): string[] {
  const before = resolvePiiPolicy(stored, registry);
  const after = resolvePiiPolicy(next, registry);
  const was = before.settings;
  const now = after.settings;
  if (before.activation === "off") return [];
  const fields: string[] = [];
  if (ACTIVATION[after.activation] < ACTIVATION[before.activation]) fields.push("Protection");
  if (MODE[now.mode] < MODE[was.mode]) fields.push("Mode");
  const storedScopes = scopesOf(stored);
  const nextScopes = scopesOf(next);
  const keys = new Set([...Object.keys(was.scopes), ...Object.keys(storedScopes), ...Object.keys(nextScopes)]);
  for (const key of keys) {
    // A core or registered key as the scan reads it; any other key as stored.
    const wasOn = Object.hasOwn(was.scopes, key) ? was.scopes[key] : storedScopes[key] !== false;
    const isOn = Object.hasOwn(now.scopes, key) ? now.scopes[key] : nextScopes[key] !== false;
    if (wasOn && !isOn) fields.push(`Scanned content: ${CORE_SCOPE_LABELS[key] ?? key}`);
  }
  if (was.detectors.entityTypes.some((type) => !now.detectors.entityTypes.includes(type))) fields.push("Entity types");
  if (RETENTION[now.rawRetention] < RETENTION[was.rawRetention]) fields.push("Raw value retention");
  if (was.actions.reportToAdmins && !now.actions.reportToAdmins) fields.push("Reports to admins");
  if (now.provider.model.trim() !== was.provider.model.trim() || now.provider.type !== was.provider.type) {
    fields.push("Detection model");
  }
  return fields;
}
