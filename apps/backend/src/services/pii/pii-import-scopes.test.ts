import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";
import { expect, it } from "vitest";

import { isPiiSubjectInScope, PiiImportScopeRegistry } from "./pii-import-scopes.js";

const partner = { subjectKind: "partner_import", scopeKey: "partnerImports", defaultOn: true };

it.each([
  ["a reserved subject kind", { ...partner, subjectKind: "upload" }],
  ["a reserved subject kind", { ...partner, subjectKind: "chat_prompt" }],
  ["a reserved scope key", { ...partner, scopeKey: "uploads" }],
  ["a reserved scope key", { ...partner, scopeKey: "chatPrompts" }],
  ["a malformed subject kind", { ...partner, subjectKind: "Partner Import" }],
  ["a malformed scope key", { ...partner, scopeKey: "partner-imports" }]
])("rejects %s", (_name, scope) => {
  expect(() => new PiiImportScopeRegistry().register(scope)).toThrow(/Invalid or reserved/);
});

it("rejects a second source with the same subject kind or scope key", () => {
  const registry = new PiiImportScopeRegistry();
  registry.register(partner);
  expect(() => registry.register({ ...partner, scopeKey: "otherImports" })).toThrow(/already registered/);
  expect(() => registry.register({ ...partner, subjectKind: "other_import" })).toThrow(/already registered/);
  expect(registry.list()).toEqual([partner]);
});

it("rejects a registration after the registry is frozen", () => {
  const registry = new PiiImportScopeRegistry();
  registry.freeze();
  expect(() => registry.register(partner)).toThrow(/frozen/);
});

it("accepts the registered keys and the legacy key in a save", () => {
  const registry = new PiiImportScopeRegistry();
  expect(registry.requestScopeKeys()).toEqual(["microsoftImports"]);
  registry.register(partner);
  expect(registry.requestScopeKeys()).toEqual(["partnerImports", "microsoftImports"]);
});

it("gates a registered import by its own scope and an unregistered import as in scope", () => {
  const registry = new PiiImportScopeRegistry();
  registry.register(partner);
  const settings = { ...DEFAULT_PII_PROTECTION, scopes: { chatPrompts: true, uploads: true, partnerImports: false } };
  expect(isPiiSubjectInScope(settings, { kind: "import", subjectKind: "partner_import" }, registry)).toBe(false);
  expect(isPiiSubjectInScope(settings, { kind: "import", subjectKind: "unknown_import" }, registry)).toBe(true);
  expect(isPiiSubjectInScope({ ...settings, scopes: { ...settings.scopes, uploads: false } }, { kind: "upload" }, registry)).toBe(false);
});
