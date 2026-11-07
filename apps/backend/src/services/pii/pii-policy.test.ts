import { describe, expect, it, test, vi } from "vitest";

import {
  buildPiiProtectionSettingsRequestSchema,
  DEFAULT_PII_PROTECTION,
  PII_ENTITY_TYPES,
  PII_POLICY_HEALTH_REASONS,
  PII_PROVIDER_MODEL_MAX_LENGTH,
  PiiProtectionSettingsRequestSchema,
  PiiProtectionSettingsSchema
} from "@cogniplane/shared-types";

import { PiiImportScopeRegistry } from "./pii-import-scopes.js";
import { logPiiPolicyHealth, mergeStoredPiiScopes, resolvePiiPolicy } from "./pii-policy.js";

const noImports = new PiiImportScopeRegistry();
const partner = new PiiImportScopeRegistry();
partner.register({ subjectKind: "partner_import", scopeKey: "partnerImports", defaultOn: true });

// A policy as an older admin form saved it: core scopes and one import scope.
const legacyRow = {
  enabled: true,
  mode: "transform",
  rawRetention: "admin_only",
  provider: { type: "openai-compatible", model: "model-x" },
  scopes: { chatPrompts: true, uploads: false, partnerImports: false },
  actions: { reportToAdmins: false },
  detectors: { useRulesFirst: false, entityTypes: ["email", "government_id"] }
};

// ── Malformed stored policies. The contract test at the end runs on each. ──

const UNKNOWN_KEYS_ROW = {
  ...legacyRow,
  futureOption: true,
  provider: { ...legacyRow.provider, model: " m ", extra: 1 },
  actions: { ...legacyRow.actions, extra: 1 },
  detectors: { ...legacyRow.detectors, extra: 1 }
};

const base = DEFAULT_PII_PROTECTION as Record<string, unknown>;
const without = (...keys: string[]) => Object.fromEntries(Object.entries(base).filter(([k]) => !keys.includes(k)));
// [name, stored policy, activation, health state, reasons]
const ACTIVATION_CASES = [
  ["enabled false keeps a remembered mode", { ...base, enabled: false, mode: "block" }, "off", "ok", []],
  ["enabled false with an invalid mode", { ...base, enabled: false, mode: "bogus" }, "off", "warning", ["mode_invalid"]],
  ["mode off with a missing enabled", { ...without("enabled"), mode: "off" }, "off", "warning", ["enabled_invalid"]],
  ["mode off with an invalid enabled", { ...base, enabled: "no", mode: "off" }, "off", "warning", ["enabled_invalid"]],
  ["enabled true with an active mode", { ...base, enabled: true, mode: "detect" }, "on", "ok", []],
  ["enabled true with mode off", { ...base, enabled: true, mode: "off" }, "invalid", "error", ["mode_off_while_enabled"]],
  ["enabled true with an invalid mode", { ...base, enabled: true, mode: "bogus" }, "invalid", "error", ["mode_invalid"]],
  ["an invalid enabled with an active mode", { ...base, enabled: "yes", mode: "detect" }, "invalid", "error", ["enabled_invalid"]],
  ["a missing enabled and a missing mode", without("enabled", "mode"), "invalid", "error", ["enabled_invalid", "mode_invalid"]],
  ["both invalid", { ...base, enabled: 1, mode: 2 }, "invalid", "error", ["enabled_invalid", "mode_invalid"]],
  ["a value that is not an object", "garbage", "invalid", "error", ["policy_not_object", "enabled_invalid", "mode_invalid"]]
] as const;

const BAD_PROVIDER = { type: "openai-compatible", model: 42 };
const DETECT_WITHOUT_PROVIDER_TYPE = { ...legacyRow, mode: "detect", provider: { model: "kept" } };

const RECOVERED_LEAVES_ROW = {
  ...legacyRow,
  rawRetention: "forever",
  scopes: { chatPrompts: false, uploads: "no", partnerImports: 1 },
  actions: { reportToAdmins: "yes" },
  detectors: { useRulesFirst: null, entityTypes: [] }
};

// [name, stored entity types, shown entity types, reason]
const ENTITY_TYPE_CASES = [
  ["missing", undefined, [...PII_ENTITY_TYPES], "entity_types_invalid"],
  ["not a list", "email", [...PII_ENTITY_TYPES], "entity_types_invalid"],
  ["only unsupported types", ["ip_address"], [...PII_ENTITY_TYPES], "entity_types_invalid"],
  ["some unsupported types", ["email", "ip_address", 7], ["email"], "entity_types_unsupported"],
  ["some unsupported and repeated types", ["email", "ip_address", "email"], ["email"], "entity_types_unsupported"]
] as const;
const withEntityTypes = (entityTypes: unknown) => ({ ...legacyRow, detectors: { useRulesFirst: true, entityTypes } });

const HIDDEN_VALUES_ROW = {
  ...legacyRow,
  mode: "SECRET-MODE",
  provider: { type: "SECRET-TYPE", model: "m" },
  scopes: { chatPrompts: true, uploads: true, secretKeyName: "x" }
};

const REPEATED_TYPES_ROW = withEntityTypes(["email", "phone", "email"]);
// More entries than the save accepts, so some repeat.
const TOO_MANY_TYPES_ROW = withEntityTypes([...PII_ENTITY_TYPES, "email"]);
const LONG_MODEL_ROW = { ...legacyRow, provider: { type: "openai-compatible", model: "m".repeat(PII_PROVIDER_MODEL_MAX_LENGTH + 1) } };

describe("a stored policy that matches the schema", () => {
  it("keeps every value when its import source is registered", () => {
    const policy = resolvePiiPolicy(legacyRow, partner);
    expect(policy.settings).toEqual(legacyRow);
    expect(policy).toMatchObject({ activation: "on", providerUsable: true, health: { state: "ok", reasons: [], fields: [] } });
  });

  it("keeps every other value and hides the scope when no source registers it", () => {
    const policy = resolvePiiPolicy(legacyRow, noImports);
    const { partnerImports: _hidden, ...coreScopes } = legacyRow.scopes;
    expect(policy.settings).toEqual({ ...legacyRow, scopes: coreScopes });
    expect(policy.health.state).toBe("ok");
  });

  it("shows only the fields that a save accepts, and trims the model name", () => {
    const policy = resolvePiiPolicy(UNKNOWN_KEYS_ROW, partner);
    expect(policy.settings).toEqual({ ...legacyRow, provider: { type: "openai-compatible", model: "m" } });
    expect(policy.health.state).toBe("ok");
    expect(buildPiiProtectionSettingsRequestSchema(["partnerImports"]).safeParse(policy.settings).success).toBe(true);
  });

  it("gives a registered scope its default when the row has no value for it", () => {
    const policy = resolvePiiPolicy({ ...legacyRow, scopes: { chatPrompts: true, uploads: true } }, partner);
    expect(policy.settings.scopes).toEqual({ chatPrompts: true, uploads: true, partnerImports: true });
    expect(policy.health.state).toBe("ok");
  });
});

test.each([null, undefined])("no stored policy (%s) is the Off default", (stored) => {
  const policy = resolvePiiPolicy(stored, partner);
  expect(policy.settings).toEqual({ ...DEFAULT_PII_PROTECTION, scopes: { chatPrompts: true, uploads: true, partnerImports: true } });
  expect(policy.activation).toBe("off");
  expect(policy.health).toEqual({ state: "ok", reasons: [], fields: [] });
});

describe("the activation table", () => {
  it.each(ACTIVATION_CASES)("%s", (_name, stored, activation, state, reasons) => {
    const policy = resolvePiiPolicy(stored, noImports);
    expect(policy.activation).toBe(activation);
    expect(policy.health.state).toBe(state);
    for (const reason of reasons) expect(policy.health.reasons).toContain(reason);
    if (state === "ok") expect(policy.health.reasons).toEqual([]);
    // The form shows protection as on unless the activation is off.
    expect(policy.settings.enabled).toBe(activation === "off" ? policy.settings.enabled : true);
  });

  it("shows Block for mode Off with protection on, so a save with no change keeps protection on", () => {
    const policy = resolvePiiPolicy({ ...legacyRow, enabled: true, mode: "off" }, noImports);
    expect(policy.activation).toBe("invalid");
    expect(policy.settings).toMatchObject({ enabled: true, mode: "block" });
    expect(resolvePiiPolicy(policy.settings, noImports)).toMatchObject({ activation: "on", settings: { mode: "block" } });
  });

  it("makes block and transform invalid, and keeps detect on rules only, when a provider field is invalid", () => {
    for (const mode of ["block", "transform"] as const) {
      expect(resolvePiiPolicy({ ...legacyRow, mode, provider: BAD_PROVIDER }, noImports).activation).toBe("invalid");
    }
    const detect = resolvePiiPolicy(DETECT_WITHOUT_PROVIDER_TYPE, noImports);
    expect(detect).toMatchObject({ activation: "on", providerUsable: false });
    expect(detect.health).toEqual({ state: "warning", reasons: ["provider_invalid"], fields: ["provider.type"] });
    // The valid sibling stays: no other model replaces it.
    expect(detect.settings.provider.model).toBe("kept");
  });
});

describe("leaf recovery", () => {
  it("keeps each valid leaf and gives each invalid leaf its safe value", () => {
    const policy = resolvePiiPolicy(RECOVERED_LEAVES_ROW, partner);
    expect(policy.settings).toMatchObject({
      enabled: true,
      mode: "transform",
      rawRetention: "never",
      provider: { model: "model-x" },
      scopes: { chatPrompts: false, uploads: true, partnerImports: true },
      actions: { reportToAdmins: true },
      detectors: { useRulesFirst: true, entityTypes: [] }
    });
    expect(policy.activation).toBe("on");
    expect(policy.health).toEqual({
      state: "warning",
      reasons: ["raw_retention_invalid", "scope_invalid", "actions_invalid", "detectors_invalid"],
      fields: ["rawRetention", "scopes.uploads", "scopes.partnerImports", "actions.reportToAdmins", "detectors.useRulesFirst"]
    });
  });

  it("turns every scope on when the scope object is malformed", () => {
    const policy = resolvePiiPolicy({ ...legacyRow, scopes: [false] }, partner);
    expect(policy.settings.scopes).toEqual({ chatPrompts: true, uploads: true, partnerImports: true });
  });

  it.each(ENTITY_TYPE_CASES)("recovers an entity type list that is %s", (_name, entityTypes, expected, reason) => {
    const policy = resolvePiiPolicy(withEntityTypes(entityTypes), noImports);
    expect(policy.settings.detectors.entityTypes).toEqual(expected);
    expect(policy.health).toEqual({ state: "warning", reasons: [reason], fields: ["detectors.entityTypes"] });
  });

  it("puts no stored value and no unregistered key name in the health report", () => {
    const policy = resolvePiiPolicy(HIDDEN_VALUES_ROW, noImports);
    const report = JSON.stringify(policy.health);
    expect(report).not.toMatch(/SECRET|secretKeyName/);
    expect(policy.settings.scopes).toEqual({ chatPrompts: true, uploads: true });
  });

  it.each([
    ["repeated types", REPEATED_TYPES_ROW, ["email", "phone"]],
    ["more types than the save accepts", TOO_MANY_TYPES_ROW, [...PII_ENTITY_TYPES]]
  ] as const)("counts each entity type once for %s, with no health issue", (_name, stored, expected) => {
    const policy = resolvePiiPolicy(stored, noImports);
    expect(policy.settings.detectors.entityTypes).toEqual(expected);
    expect(policy.health).toEqual({ state: "ok", reasons: [], fields: [] });
  });

  it("treats a model name longer than the save limit as an invalid provider field", () => {
    const policy = resolvePiiPolicy(LONG_MODEL_ROW, noImports);
    expect(policy).toMatchObject({ activation: "invalid", providerUsable: false, settings: { provider: { model: "" } } });
    expect(policy.health).toEqual({ state: "error", reasons: ["provider_invalid"], fields: ["provider.model"] });
    // The limit applies after the trim, as in the save request.
    const padded = { ...legacyRow, provider: { type: "openai-compatible", model: ` ${"m".repeat(PII_PROVIDER_MODEL_MAX_LENGTH)} ` } };
    expect(resolvePiiPolicy(padded, noImports).health.state).toBe("ok");
  });
});

test("logs a warning for recovered leaves and an error for an invalid activation, with codes and paths only", () => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  logPiiPolicyHealth(logger, "t1", resolvePiiPolicy(legacyRow, noImports));
  expect(logger.warn).not.toHaveBeenCalled();
  logPiiPolicyHealth(logger, "t1", resolvePiiPolicy({ ...legacyRow, rawRetention: "x" }, noImports));
  expect(logger.warn).toHaveBeenCalledWith(
    { tenantId: "t1", state: "warning", reasons: ["raw_retention_invalid"], fields: ["rawRetention"] },
    expect.any(String)
  );
  logPiiPolicyHealth(logger, "t1", resolvePiiPolicy({ ...legacyRow, enabled: true, mode: "off" }, noImports));
  expect(logger.error).toHaveBeenCalledWith(
    { tenantId: "t1", state: "error", reasons: ["mode_off_while_enabled"], fields: ["mode"] },
    expect.any(String)
  );
});

test("a save keeps the raw stored value of every scope key that it does not name", () => {
  const next = { ...DEFAULT_PII_PROTECTION, scopes: { chatPrompts: false, uploads: true } };
  const stored = { scopes: { chatPrompts: true, oldImports: false, junk: "kept as stored" } };
  expect(mergeStoredPiiScopes(next, stored).scopes).toEqual({ chatPrompts: false, uploads: true, oldImports: false, junk: "kept as stored" });
  expect(mergeStoredPiiScopes(next, "not an object").scopes).toEqual(next.scopes);
});

describe("the request schema", () => {
  it("accepts a registered scope key and rejects any other", () => {
    const schema = buildPiiProtectionSettingsRequestSchema(["partnerImports"]);
    const scopes = { chatPrompts: true, uploads: true };
    expect(schema.safeParse({ ...DEFAULT_PII_PROTECTION, scopes: { ...scopes, partnerImports: false } }).success).toBe(true);
    // A registered key is optional: the server keeps the stored value.
    expect(schema.safeParse({ ...DEFAULT_PII_PROTECTION, scopes }).success).toBe(true);
    expect(schema.safeParse({ ...DEFAULT_PII_PROTECTION, scopes: { ...scopes, otherImports: true } }).success).toBe(false);
    expect(schema.safeParse({ ...DEFAULT_PII_PROTECTION, scopes: { ...scopes, partnerImports: "yes" } }).success).toBe(false);
    expect(schema.safeParse({ ...DEFAULT_PII_PROTECTION, scopes: { chatPrompts: true } }).success).toBe(false);
  });

  it("rejects unknown entity types, missing fields, and unknown fields", () => {
    expect(PiiProtectionSettingsRequestSchema.safeParse({
      ...DEFAULT_PII_PROTECTION,
      detectors: { useRulesFirst: true, entityTypes: ["credit_card"] }
    }).success).toBe(false);
    const { enabled: _enabled, ...withoutEnabled } = DEFAULT_PII_PROTECTION;
    expect(PiiProtectionSettingsRequestSchema.safeParse(withoutEnabled).success).toBe(false);
    expect(PiiProtectionSettingsRequestSchema.safeParse({ ...DEFAULT_PII_PROTECTION, unexpected: true }).success).toBe(false);
  });

  it("trims the provider model and accepts an empty one (the deployment default)", () => {
    for (const [model, expected] of [["", ""], ["   ", ""], ["  my-model  ", "my-model"]]) {
      const parsed = PiiProtectionSettingsRequestSchema.safeParse({ ...DEFAULT_PII_PROTECTION, provider: { type: "openai-compatible", model } });
      expect(parsed.success && parsed.data.provider.model).toBe(expected);
    }
  });
});

test("the shared response schema keeps unknown fields", () => {
  const parsed = PiiProtectionSettingsSchema.safeParse({
    ...DEFAULT_PII_PROTECTION,
    provider: { ...DEFAULT_PII_PROTECTION.provider, model: "  model-x  ", futureOption: true }
  });
  expect(parsed.success && parsed.data.provider).toMatchObject({ model: "model-x", futureOption: true });
});

// The design contract: the shown policy is one that an admin can save with no
// change, and it is never looser than the stored policy.
const MALFORMED_POLICIES: Array<[string, unknown]> = [
  ...ACTIVATION_CASES.map(([name, stored]): [string, unknown] => [name, stored]),
  ["unknown keys", UNKNOWN_KEYS_ROW],
  ["block with an invalid provider", { ...legacyRow, mode: "block", provider: BAD_PROVIDER }],
  ["transform with an invalid provider", { ...legacyRow, mode: "transform", provider: BAD_PROVIDER }],
  ["detect with no provider type", DETECT_WITHOUT_PROVIDER_TYPE],
  ["recovered leaves", RECOVERED_LEAVES_ROW],
  ["a scope object that is a list", { ...legacyRow, scopes: [false] }],
  ...ENTITY_TYPE_CASES.map(([name, entityTypes]): [string, unknown] => [`an entity type list that is ${name}`, withEntityTypes(entityTypes)]),
  ["stored values in invalid fields", HIDDEN_VALUES_ROW],
  ["an invalid raw retention", { ...legacyRow, rawRetention: "x" }],
  ["repeated entity types", REPEATED_TYPES_ROW],
  ["more entity types than the save accepts", TOO_MANY_TYPES_ROW],
  ["a model name longer than the save limit", LONG_MODEL_ROW]
];

describe.each([["no import source", noImports], ["a registered import source", partner]] as const)("with %s, the shown policy of", (_registryName, registry) => {
  it.each(MALFORMED_POLICIES)("%s passes the save request and is not looser", (_name, stored) => {
    const policy = resolvePiiPolicy(stored, registry);
    // The PUT route parses with this schema, then refuses enabled with mode Off.
    expect(buildPiiProtectionSettingsRequestSchema(registry.requestScopeKeys()).safeParse(policy.settings).success).toBe(true);
    expect(policy.settings.enabled && policy.settings.mode === "off").toBe(false);
    // A save with no change stores a valid policy that shows the same values.
    const saved = resolvePiiPolicy(policy.settings, registry);
    expect(saved.health).toEqual({ state: "ok", reasons: [], fields: [] });
    expect(saved.settings).toEqual(policy.settings);
    // Content that the stored policy scans or stops is still scanned after that save.
    if (policy.activation !== "off") expect(saved.activation).toBe("on");
  });
});

// A new health reason needs a fixture above, so the contract also checks it.
test("the contract fixtures cover every health reason", () => {
  const covered = new Set(MALFORMED_POLICIES.flatMap(([, stored]) => resolvePiiPolicy(stored, partner).health.reasons));
  expect(covered).toEqual(new Set(PII_POLICY_HEALTH_REASONS));
});
