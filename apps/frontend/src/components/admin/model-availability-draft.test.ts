import { describe, expect, it } from "vitest";

import { makeTenantSettings } from "../../test-helpers/tenant-settings";
import {
  buildModelDraft,
  changedModelSettings,
  conflictingModelSettings,
  describeModelChanges,
  followNewer,
  rebaseModelDraft,
  removeModelFromDraft,
  startModelEditor,
  toModelAvailabilityInput,
  type ModelDraft
} from "./model-availability-draft";

const SONNET = "deepagents/claude-sonnet-5";
const GPT = "deepagents/gpt-6";
const KIMI = "openrouter/moonshotai/kimi-k3";
const catalog = [
  { id: SONNET, provider: "anthropic", displayName: "Claude Sonnet 5" },
  { id: GPT, provider: "openai", displayName: "GPT-6" },
  { id: KIMI, provider: "openrouter", displayName: "Kimi K3" }
] as const;

function draft(overrides: Partial<Parameters<typeof makeTenantSettings>[0]> = {}): ModelDraft {
  return buildModelDraft(makeTenantSettings({ enabledProviders: ["anthropic", "openai", "openrouter"], ...overrides }));
}

describe("changedModelSettings", () => {
  it("tells all models apart from an empty list, and ignores list order", () => {
    expect(changedModelSettings(draft({ enabledModelIds: null }), draft({ enabledModelIds: [] }))).toEqual(["enabledModelIds"]);
    expect(changedModelSettings(draft({ enabledModelIds: [SONNET, GPT] }), draft({ enabledModelIds: [GPT, SONNET] }))).toEqual([]);
    expect(changedModelSettings(draft({ enabledProviders: ["openai", "anthropic"] }), draft({ enabledProviders: ["anthropic", "openai"] }))).toEqual([]);
  });

  it("ignores the hidden list while all models are allowed", () => {
    expect(changedModelSettings(draft(), { ...draft(), enabledModelIds: [SONNET] })).toEqual([]);
  });

  it("names each changed effort on its own", () => {
    const from = draft({ modelDefaultEfforts: { [SONNET]: "high", [GPT]: "low" } });
    const to = draft({ modelDefaultEfforts: { [SONNET]: "high", [KIMI]: "low" } });
    expect(changedModelSettings(from, to)).toEqual([`effort:${GPT}`, `effort:${KIMI}`]);
  });
});

describe("toModelAvailabilityInput", () => {
  it("sends only the changed settings, with the whole effort map", () => {
    const baseline = draft({ modelDefaultEfforts: { [GPT]: "low" } });
    const edited: ModelDraft = { ...baseline, modelDefaultEfforts: { [GPT]: "low", [SONNET]: "high" } };
    expect(toModelAvailabilityInput(baseline, edited, 8)).toEqual({ expectedVersion: 8, modelDefaultEfforts: { [GPT]: "low", [SONNET]: "high" } });
  });

  it("sends all models as null and no models as an empty list", () => {
    expect(toModelAvailabilityInput(draft({ enabledModelIds: [] }), draft({ enabledModelIds: null }), 2)).toEqual({ expectedVersion: 2, enabledModelIds: null });
    expect(toModelAvailabilityInput(draft({ enabledModelIds: null }), draft({ enabledModelIds: [] }), 2)).toEqual({ expectedVersion: 2, enabledModelIds: [] });
  });
});

describe("rebaseModelDraft", () => {
  it("takes every setting that the draft did not change from the newer version", () => {
    const from = draft();
    const mine = { ...from, modelDefaultEfforts: { [SONNET]: "high" as const } };
    const theirs = draft({ enabledProviders: ["anthropic"], enabledModelIds: [SONNET], defaultModelId: SONNET, showEffortSelector: true });
    expect(rebaseModelDraft(from, mine, theirs, catalog)).toEqual({ ...theirs, modelDefaultEfforts: { [SONNET]: "high" } });
  });

  it("merges providers as turned on and turned off, so a provider turned off elsewhere stays off", () => {
    const from = draft({ enabledProviders: ["anthropic", "openrouter"] });
    const mine = { ...from, enabledProviders: [...from.enabledProviders, "openai" as const] };
    const theirs = draft({ enabledProviders: ["anthropic"] });
    expect(rebaseModelDraft(from, mine, theirs, catalog).enabledProviders).toEqual(["anthropic", "openai"]);
  });

  it("merges two model lists item by item", () => {
    const from = draft({ enabledModelIds: [SONNET, GPT] });
    const mine = { ...from, enabledModelIds: [SONNET, GPT, KIMI] };
    const theirs = draft({ enabledModelIds: [SONNET] });
    const merged = rebaseModelDraft(from, mine, theirs, catalog);
    expect(merged.modelSelectionMode).toBe("custom");
    expect(merged.enabledModelIds).toEqual([SONNET, KIMI]);
  });

  it("counts all models as the catalog, so both restrictions stay", () => {
    const from = draft({ enabledModelIds: null });
    const mine: ModelDraft = { ...from, modelSelectionMode: "custom", enabledModelIds: [SONNET, GPT] };
    const theirs = draft({ enabledModelIds: [SONNET, KIMI] });
    expect(rebaseModelDraft(from, mine, theirs, catalog).enabledModelIds).toEqual([SONNET]);
  });

  it("keeps the draft's removals when the newer version allows all models", () => {
    const from = draft({ enabledModelIds: [SONNET, GPT] });
    const mine = { ...from, enabledModelIds: [SONNET] };
    const theirs = draft({ enabledModelIds: null });
    const merged = rebaseModelDraft(from, mine, theirs, catalog);
    expect(merged.modelSelectionMode).toBe("custom");
    expect(merged.enabledModelIds).toEqual([SONNET, KIMI]);
  });

  it("keeps all models when the draft chose it", () => {
    const from = draft({ enabledModelIds: [SONNET, GPT] });
    const mine: ModelDraft = { ...from, modelSelectionMode: "all" };
    expect(rebaseModelDraft(from, mine, draft({ enabledModelIds: [SONNET] }), catalog).modelSelectionMode).toBe("all");
  });

  it("merges efforts model by model, including a cleared override", () => {
    const from = draft({ modelDefaultEfforts: { [SONNET]: "high", [GPT]: "low" } });
    const mine: ModelDraft = { ...from, modelDefaultEfforts: { [GPT]: "low" } };
    const theirs = draft({ modelDefaultEfforts: { [SONNET]: "high", [GPT]: "high", [KIMI]: "low" } });
    expect(rebaseModelDraft(from, mine, theirs, catalog).modelDefaultEfforts).toEqual({ [GPT]: "high", [KIMI]: "low" });
  });

  it("drops a model that the draft added but that the catalog no longer has", () => {
    const from = draft({ enabledModelIds: [SONNET] });
    const mine = { ...from, enabledModelIds: [SONNET, KIMI], modelDefaultEfforts: { [KIMI]: "low" as const } };
    const merged = rebaseModelDraft(from, mine, draft({ enabledModelIds: [SONNET], showEffortSelector: true }), catalog.slice(0, 2));
    expect(merged.enabledModelIds).toEqual([SONNET]);
    expect(merged.modelDefaultEfforts).toEqual({});
  });

  it("keeps the draft's default only when the merged settings make it available", () => {
    const from = draft();
    const mine = { ...from, defaultModelId: KIMI };
    expect(rebaseModelDraft(from, mine, draft({ showEffortSelector: true }), catalog).defaultModelId).toBe(KIMI);
    expect(rebaseModelDraft(from, mine, draft({ enabledProviders: ["anthropic", "openai"], defaultModelId: GPT }), catalog).defaultModelId).toBe(GPT);
    expect(rebaseModelDraft(from, { ...from, defaultModelId: null }, draft({ defaultModelId: GPT }), catalog).defaultModelId).toBe(GPT);
  });
});

describe("conflictingModelSettings", () => {
  it("is empty when the two versions changed different settings or made the same change", () => {
    const from = draft();
    const mine = { ...from, modelDefaultEfforts: { [SONNET]: "high" as const }, enabledProviders: ["anthropic" as const] };
    expect(conflictingModelSettings(from, mine, draft({ enabledModelIds: [SONNET], enabledProviders: ["anthropic"] }), catalog)).toEqual([]);
  });

  it("names a setting that both changed to different values", () => {
    const from = draft({ modelDefaultEfforts: { [GPT]: "low" } });
    const mine = { ...from, defaultModelId: SONNET, modelDefaultEfforts: { [GPT]: "high" as const } };
    const theirs = draft({ defaultModelId: GPT, modelDefaultEfforts: { [GPT]: "medium" } });
    expect(conflictingModelSettings(from, mine, theirs, catalog)).toEqual(["defaultModelId", `effort:${GPT}`]);
  });

  it("names the default model when the newer version makes the draft's choice unavailable", () => {
    const from = draft();
    expect(conflictingModelSettings(from, { ...from, defaultModelId: KIMI }, draft({ enabledModelIds: [SONNET] }), catalog)).toEqual(["defaultModelId"]);
  });
});

describe("followNewer", () => {
  const settings = (overrides: Parameters<typeof makeTenantSettings>[0]) =>
    makeTenantSettings({ enabledProviders: ["anthropic", "openai", "openrouter"], ...overrides });

  it("takes a newer version as it is while the draft has no edits", () => {
    const editor = startModelEditor(settings({ version: 7 }));
    expect(followNewer(editor, settings({ version: 8, defaultModelId: GPT }), catalog)).toEqual(startModelEditor(settings({ version: 8, defaultModelId: GPT })));
  });

  it("rebases the edits and keeps the first baseline to show what changed", () => {
    const editor = startModelEditor(settings({ version: 7 }));
    const edited = { ...editor, draft: { ...editor.draft, showEffortSelector: true } };
    const next = followNewer(edited, settings({ version: 8, enabledProviders: ["anthropic"] }), catalog);
    expect(next.baseline.version).toBe(8);
    expect(next.draft).toEqual({ ...buildModelDraft(settings({ enabledProviders: ["anthropic"] })), showEffortSelector: true });
    expect(next.mergedFrom).toEqual(editor.baseline.values);
  });

  it("returns the same editor when the edits conflict or the version is not newer", () => {
    const editor = startModelEditor(settings({ version: 7 }));
    const edited = { ...editor, draft: { ...editor.draft, defaultModelId: SONNET } };
    expect(followNewer(edited, settings({ version: 8, defaultModelId: GPT }), catalog)).toBe(edited);
    expect(followNewer(edited, settings({ version: 7, defaultModelId: GPT }), catalog)).toBe(edited);
  });
});

describe("removeModelFromDraft", () => {
  it("prunes the saved settings as the backend does, and keeps an untouched draft clean", () => {
    const baseline = draft({ enabledModelIds: [KIMI], defaultModelId: KIMI, modelDefaultEfforts: { [KIMI]: "low", [GPT]: "high" } });
    const edited = { ...baseline, showEffortSelector: true };
    const result = removeModelFromDraft(baseline, edited, KIMI);
    expect(result.baseline).toEqual({ ...baseline, modelSelectionMode: "all", enabledModelIds: [], defaultModelId: null, modelDefaultEfforts: { [GPT]: "high" } });
    expect(changedModelSettings(result.baseline, result.draft)).toEqual(["showEffortSelector"]);
  });

  it("drops the model from a list that the draft changed, without allowing more models", () => {
    const baseline = draft({ enabledModelIds: null, defaultModelId: GPT });
    const edited: ModelDraft = { ...baseline, modelSelectionMode: "custom", enabledModelIds: [KIMI], defaultModelId: KIMI };
    const result = removeModelFromDraft(baseline, edited, KIMI).draft;
    expect(result.modelSelectionMode).toBe("custom");
    expect(result.enabledModelIds).toEqual([]);
    expect(result.defaultModelId).toBe(GPT);
  });
});

describe("describeModelChanges", () => {
  it("states each change in the order of the page", () => {
    const from = draft({ enabledModelIds: [SONNET, GPT] });
    const to = draft({ enabledProviders: ["anthropic", "openai"], enabledModelIds: [SONNET, KIMI], defaultModelId: SONNET, modelDefaultEfforts: { [GPT]: "low" } });
    expect(describeModelChanges(from, to, catalog).map(({ label, detail }) => `${label}: ${detail}`)).toEqual([
      "Default model: Claude Sonnet 5.",
      "Available models: Added: Kimi K3. Removed: GPT-6.",
      "Default effort for GPT-6: low.",
      "Providers in use: Turned off: OpenRouter."
    ]);
  });
});
