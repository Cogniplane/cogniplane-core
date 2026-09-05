import { test, expect } from "vitest";

import { pruneUnknownModelIds } from "./admin-tenant-settings-routes.js";

const known = new Set(["openai/gpt-5.6-sol", "deepagents/claude-sonnet-5", "custom/my-model"]);

test("pruneUnknownModelIds: leaves a null allowlist alone", () => {
  // null means "all models" — there is nothing to prune, and turning it into
  // an array here would narrow the tenant's settings.
  const settings = { enabledModelIds: null, other: "untouched" };
  expect(pruneUnknownModelIds(settings, known)).toBe(settings);
});

test("pruneUnknownModelIds: returns the same object when every id is known", () => {
  // Identity matters: an unchanged read must not look like a settings change.
  const settings = { enabledModelIds: ["openai/gpt-5.6-sol", "custom/my-model"] };
  expect(pruneUnknownModelIds(settings, known)).toBe(settings);
});

test("pruneUnknownModelIds: drops ids the catalog no longer has", () => {
  const settings = {
    enabledModelIds: ["openai/gpt-5.6-sol", "openai/gpt-5.4", "deepagents/claude-sonnet-5"]
  };
  expect(pruneUnknownModelIds(settings, known).enabledModelIds).toEqual([
    "openai/gpt-5.6-sol",
    "deepagents/claude-sonnet-5"
  ]);
});

test("pruneUnknownModelIds: an allowlist that empties out becomes null, not []", () => {
  // [] would read as "no models allowed" and lock the tenant out of the
  // picker. Every model they chose is gone, so fall back to "all models".
  const settings = { enabledModelIds: ["openai/gpt-5.4", "openrouter/openai/gpt-oss-120b:free"] };
  expect(pruneUnknownModelIds(settings, known).enabledModelIds).toBeNull();
});

test("pruneUnknownModelIds: preserves the rest of the settings record", () => {
  const settings = {
    enabledModelIds: ["openai/gpt-5.4", "custom/my-model"],
    approvalPolicy: "on-request",
    version: 7
  };
  expect(pruneUnknownModelIds(settings, known)).toEqual({
    enabledModelIds: ["custom/my-model"],
    approvalPolicy: "on-request",
    version: 7
  });
});
