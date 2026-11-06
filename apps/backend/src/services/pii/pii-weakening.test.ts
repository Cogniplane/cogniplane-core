import { describe, expect, test } from "vitest";

import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";

import { PiiImportScopeRegistry } from "./pii-import-scopes.js";
import { weakerPiiFields } from "./pii-weakening.js";

const ON: PiiProtectionSettings = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block", provider: { type: "openai-compatible", model: "pii-small" } };

function registry(): PiiImportScopeRegistry {
  const scopes = new PiiImportScopeRegistry();
  scopes.register({ subjectKind: "sharepoint_import", scopeKey: "sharepointImports", defaultOn: true });
  return scopes;
}

describe("weakerPiiFields", () => {
  test("the same policy, or a stronger one, is not weaker", () => {
    expect(weakerPiiFields(ON, ON, registry())).toEqual([]);
    expect(weakerPiiFields({ ...ON, mode: "detect" }, ON, registry())).toEqual([]);
    expect(weakerPiiFields(null, ON, registry())).toEqual([]);
    expect(weakerPiiFields({ ...ON, rawRetention: "admin_only" }, { ...ON, rawRetention: "never" }, registry())).toEqual([]);
    expect(weakerPiiFields({ ...ON, detectors: { useRulesFirst: true, entityTypes: ["email"] } }, ON, registry())).toEqual([]);
  });

  test("turning protection off is weaker", () => {
    expect(weakerPiiFields(ON, { ...ON, enabled: false }, registry())).toEqual(["Protection"]);
    expect(weakerPiiFields(ON, DEFAULT_PII_PROTECTION, registry())).toEqual(["Protection", "Mode", "Detection model"]);
  });

  test("a lower mode is weaker: block > transform > detect", () => {
    expect(weakerPiiFields(ON, { ...ON, mode: "transform" }, registry())).toEqual(["Mode"]);
    expect(weakerPiiFields({ ...ON, mode: "transform" }, { ...ON, mode: "detect" }, registry())).toEqual(["Mode"]);
    expect(weakerPiiFields({ ...ON, mode: "detect" }, { ...ON, mode: "transform" }, registry())).toEqual([]);
  });

  test("a scope turned off is weaker, also a registered import scope", () => {
    expect(weakerPiiFields(ON, { ...ON, scopes: { chatPrompts: false, uploads: true } }, registry()))
      .toEqual(["Scanned content: Chat prompts"]);
    expect(weakerPiiFields(ON, { ...ON, scopes: { chatPrompts: true, uploads: true, sharepointImports: false } }, registry()))
      .toEqual(["Scanned content: sharepointImports"]);
    // A scope turned on is stronger.
    expect(weakerPiiFields({ ...ON, scopes: { chatPrompts: false, uploads: true } }, ON, registry())).toEqual([]);
  });

  // The save accepts the legacy key without its overlay and keeps it as
  // stored; the value applies when the overlay comes back. A key that no
  // overlay registers now still counts.
  test("a scope key that no overlay registers now is classified as stored", () => {
    const none = new PiiImportScopeRegistry();
    const withLegacy = { ...ON, scopes: { chatPrompts: true, uploads: true, microsoftImports: true } };
    expect(weakerPiiFields(withLegacy, { ...withLegacy, scopes: { chatPrompts: true, uploads: true, microsoftImports: false } }, none))
      .toEqual(["Scanned content: microsoftImports"]);
    // No stored value: an import that no source registers is in scope, so it counts as on.
    expect(weakerPiiFields(ON, { ...ON, scopes: { chatPrompts: true, uploads: true, microsoftImports: false } }, none))
      .toEqual(["Scanned content: microsoftImports"]);
    // A stored key of an overlay that is gone: turned back on is not weaker.
    const off = { ...ON, scopes: { chatPrompts: true, uploads: true, retiredImports: false } };
    expect(weakerPiiFields(off, { ...off, scopes: { chatPrompts: true, uploads: true, retiredImports: true } }, none)).toEqual([]);
    // A registered key with no stored value uses its registered default.
    const offByDefault = new PiiImportScopeRegistry();
    offByDefault.register({ subjectKind: "partner_import", scopeKey: "partnerImports", defaultOn: false });
    expect(weakerPiiFields(ON, { ...ON, scopes: { chatPrompts: true, uploads: true, partnerImports: false } }, offByDefault)).toEqual([]);
  });

  test("an entity type removed, more raw values kept, reports off, or a new model are weaker", () => {
    expect(weakerPiiFields(ON, { ...ON, detectors: { useRulesFirst: true, entityTypes: ["email"] } }, registry())).toEqual(["Entity types"]);
    expect(weakerPiiFields(ON, { ...ON, rawRetention: "reversible_encrypted" }, registry())).toEqual(["Raw value retention"]);
    expect(weakerPiiFields({ ...ON, rawRetention: "reversible_encrypted" }, { ...ON, rawRetention: "admin_only" }, registry()))
      .toEqual(["Raw value retention"]);
    expect(weakerPiiFields(ON, { ...ON, actions: { reportToAdmins: false } }, registry())).toEqual(["Reports to admins"]);
    expect(weakerPiiFields(ON, { ...ON, provider: { type: "openai-compatible", model: "pii-tiny" } }, registry())).toEqual(["Detection model"]);
  });

  test("the rules-first flag is not read by the scan, so its change is not weaker", () => {
    expect(weakerPiiFields(ON, { ...ON, detectors: { ...ON.detectors, useRulesFirst: false } }, registry())).toEqual([]);
  });

  // A stored policy that is not valid stops content in scope: a save that
  // lets content through again is weaker, even in block mode.
  test("a stored policy that is not valid counts as stopping content", () => {
    const invalid = { ...ON, enabled: "yes" };
    expect(weakerPiiFields(invalid, ON, registry())).toEqual(["Protection"]);
    expect(weakerPiiFields(invalid, { ...ON, enabled: false }, registry())).toEqual(["Protection"]);
  });
});
