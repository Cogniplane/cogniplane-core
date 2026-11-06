import { z } from "zod";

import {
  DEFAULT_PII_PROTECTION,
  PII_ENTITY_TYPES,
  PiiEntityTypeSchema,
  PiiModeSchema,
  PiiProviderModelSchema,
  PiiProviderTypeSchema,
  PiiRawRetentionSchema
} from "@cogniplane/shared-types";
import type {
  PiiEntityType,
  PiiPolicyHealth,
  PiiPolicyHealthReason,
  PiiProtectionSettings,
  PiiScopes
} from "@cogniplane/shared-types";

import type { PiiImportScopeRegistry } from "./pii-import-scopes.js";

export const PII_POLICY_INVALID_CODE = "pii_policy_invalid";
export const PII_POLICY_INVALID_MESSAGE =
  "The PII protection policy of this organization is not valid. An admin must save it again.";

/**
 * - off: nothing is scanned.
 * - on: content in scope is scanned in `settings.mode`.
 * - invalid: the stored on/off choice cannot be trusted. Content in scope is
 *   stopped with `pii_policy_invalid`, before any provider call. This is not a
 *   finding, so the block path (and its byte deletion) never runs.
 */
export type PiiPolicyActivation = "off" | "on" | "invalid";

export type ResolvedPiiPolicy = {
  /**
   * The policy that the API shows and the scan uses: each valid stored leaf,
   * a safe value for each invalid leaf, and one boolean for each core and
   * registered scope. It always passes the save request schema and the save
   * checks, so a client can send it back unchanged. Its activation is never
   * looser than the stored policy: when the stored policy stops content, a
   * save with no change keeps protection on. The server never stores it
   * without an admin save.
   */
  settings: PiiProtectionSettings;
  activation: PiiPolicyActivation;
  /** False when a stored provider field is invalid. Detect then uses only the rules. */
  providerUsable: boolean;
  health: PiiPolicyHealth;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  return isObject(value) ? value : {};
}

class Issues {
  readonly reasons = new Set<PiiPolicyHealthReason>();
  readonly fields: string[] = [];

  add(reason: PiiPolicyHealthReason, field?: string): void {
    this.reasons.add(reason);
    if (field && !this.fields.includes(field)) this.fields.push(field);
  }

  /** The valid value of a leaf, or `fallback` after it records the leaf. */
  leaf<T>(schema: z.ZodType<T>, value: unknown, fallback: T, reason: PiiPolicyHealthReason, field: string): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    this.add(reason, field);
    return fallback;
  }
}

/**
 * Resolves the stored PII policy of a tenant, one leaf at a time.
 *
 * No stored policy (null or undefined) is the default: protection off.
 *
 * `enabled` and `mode` decide the activation:
 * - `enabled: false`, with any mode: off. An invalid mode adds a warning.
 * - `mode: "off"` and an invalid `enabled`: off, with a warning.
 * - `enabled: true` with an active mode: on.
 * - `enabled: true` with mode `off` or an invalid mode: invalid.
 * - an invalid `enabled` with an active or invalid mode: invalid.
 * - `block` or `transform` with an invalid provider field: invalid.
 *
 * The shown mode is the stored mode when a save accepts it. For an invalid
 * mode, or mode `off` with `enabled: true`, it is `off` when the activation is
 * off, else `block`, which is closest to stopping the content. Off is then a
 * choice that the admin makes, not the result of a save with no change.
 *
 * Every other leaf keeps its valid stored value. An invalid leaf gets a safe
 * value and a reason code: a scope is on, `rawRetention` is `never`, the
 * action and rule flags are on, and a missing or malformed entity type list is
 * every type. A list with some unsupported types keeps the supported ones and
 * reports reduced coverage. A repeated type counts once. A model name longer
 * than the save limit is an invalid provider field. An invalid provider field
 * is never replaced with another model: detect then uses only the rules.
 *
 * A stored key outside `scopes` that the schema does not know is not shown
 * and is not a health issue. The save request refuses unknown keys, so a
 * policy that showed such a key could not be sent back unchanged. The next
 * admin save removes the key from the stored policy.
 *
 * Health reports reason codes and known field paths only, never stored values
 * or stored key names that no import source registered.
 */
export function resolvePiiPolicy(
  stored: unknown,
  registry: Pick<PiiImportScopeRegistry, "list">
): ResolvedPiiPolicy {
  const issues = new Issues();
  const missing = stored === null || stored === undefined;
  if (!missing && !isObject(stored)) issues.add("policy_not_object");
  const root: JsonObject = isObject(stored) ? stored : missing ? DEFAULT_PII_PROTECTION : {};

  const enabled = z.boolean().safeParse(root.enabled);
  const mode = PiiModeSchema.safeParse(root.mode);
  if (!enabled.success) issues.add("enabled_invalid", "enabled");
  if (!mode.success) issues.add("mode_invalid", "mode");

  const provider = objectAt(root, "provider");
  const providerType = issues.leaf(PiiProviderTypeSchema, provider.type, DEFAULT_PII_PROTECTION.provider.type, "provider_invalid", "provider.type");
  const providerModel = issues.leaf(PiiProviderModelSchema, provider.model, "", "provider_invalid", "provider.model");
  const providerUsable = !issues.reasons.has("provider_invalid");

  let activation: PiiPolicyActivation;
  if (enabled.success && !enabled.data) activation = "off";
  else if (!enabled.success) activation = mode.success && mode.data === "off" ? "off" : "invalid";
  else if (!mode.success) activation = "invalid";
  else if (mode.data === "off") {
    activation = "invalid";
    issues.add("mode_off_while_enabled", "mode");
  } else activation = mode.data !== "detect" && !providerUsable ? "invalid" : "on";

  const actions = objectAt(root, "actions");
  const detectors = objectAt(root, "detectors");
  const settings: PiiProtectionSettings = {
    enabled: enabled.success ? enabled.data : activation !== "off",
    // A save refuses mode Off with protection on, so that pair gets the
    // fallback of an invalid mode.
    mode: mode.success && !issues.reasons.has("mode_off_while_enabled")
      ? mode.data
      : activation === "off" ? "off" : "block",
    rawRetention: issues.leaf(PiiRawRetentionSchema, root.rawRetention, "never", "raw_retention_invalid", "rawRetention"),
    provider: { type: providerType, model: providerModel },
    scopes: resolveScopes(root, registry, issues),
    actions: {
      reportToAdmins: issues.leaf(z.boolean(), actions.reportToAdmins, true, "actions_invalid", "actions.reportToAdmins")
    },
    detectors: {
      useRulesFirst: issues.leaf(z.boolean(), detectors.useRulesFirst, true, "detectors_invalid", "detectors.useRulesFirst"),
      entityTypes: resolveEntityTypes(detectors.entityTypes, issues)
    }
  };

  const state = activation === "invalid" ? "error" : issues.reasons.size > 0 ? "warning" : "ok";
  return {
    settings,
    activation,
    providerUsable,
    health: { state, reasons: [...issues.reasons], fields: issues.fields }
  };
}

// Core scopes are required. A registered scope with no stored value uses its
// default. A stored key that no import source registered is not read.
function resolveScopes(
  root: JsonObject,
  registry: Pick<PiiImportScopeRegistry, "list">,
  issues: Issues
): PiiScopes {
  const malformed = !isObject(root.scopes);
  const stored = objectAt(root, "scopes");
  const value = (key: string, fallbackWhenMissing: boolean | null): boolean => {
    if (typeof stored[key] === "boolean") return stored[key];
    if (!malformed && stored[key] === undefined && fallbackWhenMissing !== null) return fallbackWhenMissing;
    issues.add("scope_invalid", `scopes.${key}`);
    return true;
  };
  const scopes: PiiScopes = { chatPrompts: value("chatPrompts", null), uploads: value("uploads", null) };
  for (const scope of registry.list()) scopes[scope.scopeKey] = value(scope.scopeKey, scope.defaultOn);
  return scopes;
}

function resolveEntityTypes(stored: unknown, issues: Issues): PiiEntityType[] {
  if (!Array.isArray(stored)) {
    issues.add("entity_types_invalid", "detectors.entityTypes");
    return [...PII_ENTITY_TYPES];
  }
  const known = stored.filter((item): item is PiiEntityType => PiiEntityTypeSchema.safeParse(item).success);
  // A repeated type counts once. It changes nothing in the scan, so it is not
  // a health issue. Without repeats, the list fits the save limit.
  const supported = [...new Set(known)];
  if (known.length === stored.length) return supported;
  // A list with no supported type would scan for nothing, so it is malformed.
  if (supported.length === 0) {
    issues.add("entity_types_invalid", "detectors.entityTypes");
    return [...PII_ENTITY_TYPES];
  }
  issues.add("entity_types_unsupported", "detectors.entityTypes");
  return supported;
}

/** One log line for a policy that is not ok. Error when content is stopped. */
export function logPiiPolicyHealth(
  logger: { warn(payload: unknown, message: string): void; error(payload: unknown, message: string): void } | undefined,
  tenantId: string,
  policy: ResolvedPiiPolicy
): void {
  const { state, reasons, fields } = policy.health;
  if (!logger || state === "ok") return;
  const payload = { tenantId, state, reasons, fields };
  if (state === "error") {
    logger.error(payload, "Stored PII policy is not valid. Content in scope is stopped until an admin saves the policy.");
  } else {
    logger.warn(payload, "Stored PII policy has invalid fields. Safe values replace them until an admin saves the policy.");
  }
}

/**
 * The policy to store after an admin save. The request names the core scopes
 * and some import scopes. Every other key of the raw stored scope map stays
 * as stored, not interpreted, so an admin choice survives a deployment that
 * runs without the overlay for a while.
 */
export function mergeStoredPiiScopes(next: PiiProtectionSettings, stored: unknown): PiiProtectionSettings {
  const storedScopes = isObject(stored) ? objectAt(stored, "scopes") : {};
  return { ...next, scopes: { ...storedScopes, ...next.scopes } as PiiScopes };
}
