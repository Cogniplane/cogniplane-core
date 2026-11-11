import type { EffortLevel, Model, ModelProvider, TenantSettings } from "@cogniplane/shared-types";
import { isModelEnabled, MODEL_PROVIDER_META } from "@cogniplane/shared-types";

/** The model settings that Admin > Models edits as one draft. */
export type ModelDraft = {
  enabledProviders: ModelProvider[];
  // "all" keeps enabledModelIds null server-side; "custom" persists the list.
  modelSelectionMode: "all" | "custom";
  enabledModelIds: string[];
  defaultModelId: string | null;
  modelDefaultEfforts: Record<string, EffortLevel>;
  showEffortSelector: boolean;
};

/**
 * One saved model setting. The default effort of each model is a separate
 * setting, so edits to the efforts of different models merge.
 */
export type ModelSetting =
  | "enabledProviders"
  | "enabledModelIds"
  | "defaultModelId"
  | "showEffortSelector"
  | `effort:${string}`;

/** The save request. It holds only the settings that the draft changed. */
export type ModelAvailabilityInput = {
  expectedVersion: number;
  enabledProviders?: ModelProvider[];
  enabledModelIds?: string[] | null;
  defaultModelId?: string | null;
  modelDefaultEfforts?: Record<string, EffortLevel>;
  showEffortSelector?: boolean;
};

type CatalogModel = Pick<Model, "id" | "provider" | "displayName">;

export function buildModelDraft(settings: TenantSettings): ModelDraft {
  return {
    enabledProviders: [...settings.enabledProviders],
    modelSelectionMode: settings.enabledModelIds === null ? "all" : "custom",
    enabledModelIds: [...(settings.enabledModelIds ?? [])],
    defaultModelId: settings.defaultModelId,
    modelDefaultEfforts: { ...settings.modelDefaultEfforts },
    showEffortSelector: settings.showEffortSelector
  };
}

/** The saved form of the model selection: null allows all models, an empty list allows none. */
function selection(draft: ModelDraft): string[] | null {
  return draft.modelSelectionMode === "all" ? null : draft.enabledModelIds;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function setDelta<T extends string>(from: readonly T[], to: readonly T[]) {
  return { added: to.filter((item) => !from.includes(item)), removed: from.filter((item) => !to.includes(item)) };
}

function applyDelta<T extends string>(onto: readonly T[], delta: { added: T[]; removed: T[] }): T[] {
  return [...onto.filter((item) => !delta.removed.includes(item)), ...delta.added.filter((item) => !onto.includes(item))];
}

const effortSetting = (modelId: string): ModelSetting => `effort:${modelId}`;
const effortModelId = (setting: ModelSetting): string | null =>
  setting.startsWith("effort:") ? setting.slice("effort:".length) : null;

/** The settings that differ between two drafts. Lists compare as sets. */
export function changedModelSettings(from: ModelDraft, to: ModelDraft): ModelSetting[] {
  const changed: ModelSetting[] = [];
  if (!sameSet(from.enabledProviders, to.enabledProviders)) changed.push("enabledProviders");
  const before = selection(from);
  const after = selection(to);
  if (before === null || after === null ? before !== after : !sameSet(before, after)) changed.push("enabledModelIds");
  if (from.defaultModelId !== to.defaultModelId) changed.push("defaultModelId");
  for (const modelId of new Set([...Object.keys(from.modelDefaultEfforts), ...Object.keys(to.modelDefaultEfforts)])) {
    if (from.modelDefaultEfforts[modelId] !== to.modelDefaultEfforts[modelId]) changed.push(effortSetting(modelId));
  }
  if (from.showEffortSelector !== to.showEffortSelector) changed.push("showEffortSelector");
  return changed;
}

/**
 * The save request for `draft`, which started from the saved `baseline`. It
 * sends only the changed settings, so a setting that the draft did not change
 * is never written. The backend replaces the effort map as a whole, so a
 * changed effort sends the full map of the draft. That map is correct only
 * because the draft is always rebased on the version in `expectedVersion`.
 */
export function toModelAvailabilityInput(baseline: ModelDraft, draft: ModelDraft, expectedVersion: number): ModelAvailabilityInput {
  const changed = changedModelSettings(baseline, draft);
  return {
    expectedVersion,
    ...(changed.includes("enabledProviders") ? { enabledProviders: draft.enabledProviders } : {}),
    ...(changed.includes("enabledModelIds") ? { enabledModelIds: selection(draft) } : {}),
    ...(changed.includes("defaultModelId") ? { defaultModelId: draft.defaultModelId } : {}),
    ...(changed.some((setting) => effortModelId(setting) !== null) ? { modelDefaultEfforts: draft.modelDefaultEfforts } : {}),
    ...(changed.includes("showEffortSelector") ? { showEffortSelector: draft.showEffortSelector } : {})
  };
}

/**
 * Put the edits that `draft` made on `from` onto `onto`, the newer saved
 * settings. A setting that the draft did not change takes its value from
 * `onto`, so a change saved meanwhile stays.
 * - Providers merge as added and removed sets, so a provider that `onto`
 *   turned off stays off unless the draft itself turned it on.
 * - The model list merges as added and removed sets. "All models" counts as
 *   every model in the catalog. When the draft chose "All models", that
 *   choice is kept.
 * - Each model's default effort merges on its own.
 * - The draft's default model is kept only when the merged settings make it
 *   available, as the backend requires. Otherwise the default of `onto` stays.
 * - A model that the draft added but that the catalog no longer has is
 *   dropped, because the backend refuses unknown model IDs.
 */
export function rebaseModelDraft(from: ModelDraft, draft: ModelDraft, onto: ModelDraft, catalog: readonly CatalogModel[]): ModelDraft {
  const known = new Set(catalog.map((model) => model.id));
  const allModelIds = catalog.map((model) => model.id);
  const changed = new Set(changedModelSettings(from, draft));

  const enabledProviders = changed.has("enabledProviders")
    ? applyDelta(onto.enabledProviders, setDelta(from.enabledProviders, draft.enabledProviders))
    : [...onto.enabledProviders];

  let modelSelectionMode = onto.modelSelectionMode;
  let enabledModelIds = [...onto.enabledModelIds];
  if (changed.has("enabledModelIds")) {
    if (draft.modelSelectionMode === "all") {
      modelSelectionMode = "all";
      enabledModelIds = [...draft.enabledModelIds];
    } else {
      const delta = setDelta(selection(from) ?? allModelIds, draft.enabledModelIds);
      modelSelectionMode = "custom";
      enabledModelIds = applyDelta(selection(onto) ?? allModelIds, {
        added: delta.added.filter((id) => known.has(id)),
        removed: delta.removed
      });
    }
  }

  const modelDefaultEfforts = { ...onto.modelDefaultEfforts };
  for (const setting of changed) {
    const modelId = effortModelId(setting);
    if (modelId === null) continue;
    const effort = draft.modelDefaultEfforts[modelId];
    if (effort === undefined) delete modelDefaultEfforts[modelId];
    else if (known.has(modelId)) modelDefaultEfforts[modelId] = effort;
  }

  let defaultModelId = onto.defaultModelId;
  if (changed.has("defaultModelId")) {
    const model = catalog.find((entry) => entry.id === draft.defaultModelId);
    const enabledIds = modelSelectionMode === "all" ? null : enabledModelIds;
    if (draft.defaultModelId === null || (model && isModelEnabled(model, { enabledProviders, enabledModelIds: enabledIds }))) {
      defaultModelId = draft.defaultModelId;
    }
  }

  return {
    enabledProviders,
    modelSelectionMode,
    enabledModelIds,
    defaultModelId,
    modelDefaultEfforts,
    showEffortSelector: changed.has("showEffortSelector") ? draft.showEffortSelector : onto.showEffortSelector
  };
}

function sameSetting(left: ModelDraft, right: ModelDraft, setting: ModelSetting): boolean {
  return !changedModelSettings(left, right).includes(setting);
}

/**
 * The settings that the draft and `onto` both changed from `from`, to
 * different values. The administrator must decide before the draft moves to
 * `onto`. The default model also conflicts when the draft chose a default
 * that `onto` makes unavailable, because the rebase cannot keep it.
 */
export function conflictingModelSettings(from: ModelDraft, draft: ModelDraft, onto: ModelDraft, catalog: readonly CatalogModel[]): ModelSetting[] {
  const theirs = new Set(changedModelSettings(from, onto));
  const mine = changedModelSettings(from, draft);
  const conflicts = mine.filter((setting) => theirs.has(setting) && !sameSetting(draft, onto, setting));
  if (mine.includes("defaultModelId") && !conflicts.includes("defaultModelId") &&
      rebaseModelDraft(from, draft, onto, catalog).defaultModelId !== draft.defaultModelId) {
    conflicts.push("defaultModelId");
  }
  return conflicts;
}

/**
 * The saved settings after a custom model is deleted, as the backend prunes
 * them (`pruneUnknownModelIds` and the custom model route): the model leaves
 * the list, a list that this empties allows all models again, and the model's
 * effort and default go.
 */
export function removeSavedModel(saved: ModelDraft, modelId: string): ModelDraft {
  const { [modelId]: _removed, ...modelDefaultEfforts } = saved.modelDefaultEfforts;
  const listed = saved.modelSelectionMode === "custom" && saved.enabledModelIds.includes(modelId);
  const enabledModelIds = saved.enabledModelIds.filter((id) => id !== modelId);
  return {
    ...saved,
    modelSelectionMode: listed && enabledModelIds.length === 0 ? "all" : saved.modelSelectionMode,
    enabledModelIds,
    defaultModelId: saved.defaultModelId === modelId ? null : saved.defaultModelId,
    modelDefaultEfforts
  };
}

/**
 * Remove a deleted custom model from the baseline and the draft in the same
 * way, so that the deletion is neither an unsaved edit nor a concurrent
 * change. An edit of the draft that names the model is dropped. A model list
 * that the draft changed keeps its other entries, also when it becomes empty:
 * the draft never allows more models than the administrator chose.
 */
export function removeModelFromDraft(baseline: ModelDraft, draft: ModelDraft, modelId: string): { baseline: ModelDraft; draft: ModelDraft } {
  const nextBaseline = removeSavedModel(baseline, modelId);
  const { [modelId]: _removed, ...modelDefaultEfforts } = draft.modelDefaultEfforts;
  const listUnchanged = sameSetting(baseline, draft, "enabledModelIds");
  return {
    baseline: nextBaseline,
    draft: {
      ...draft,
      modelSelectionMode: listUnchanged ? nextBaseline.modelSelectionMode : draft.modelSelectionMode,
      enabledModelIds: listUnchanged ? [...nextBaseline.enabledModelIds] : draft.enabledModelIds.filter((id) => id !== modelId),
      defaultModelId: draft.defaultModelId === modelId ? nextBaseline.defaultModelId : draft.defaultModelId,
      modelDefaultEfforts
    }
  };
}

/**
 * The draft and the saved settings that it started from. The baseline moves to
 * newer settings only together with a rebase of the draft, so a newer version
 * never makes a stale copy of an unedited setting look current.
 */
export type ModelEditor = {
  /** Its version goes into expectedVersion. */
  baseline: { version: number; values: ModelDraft };
  draft: ModelDraft;
  /** The saved values before the draft took newer settings, to show what changed. */
  mergedFrom: ModelDraft | null;
};

export function startModelEditor(settings: TenantSettings): ModelEditor {
  return { baseline: { version: settings.version, values: buildModelDraft(settings) }, draft: buildModelDraft(settings), mergedFrom: null };
}

/**
 * Put the draft's edits on newer saved settings, also when they conflict:
 * lists merge, and the draft's value wins for a setting that both changed.
 */
export function keepEditsOn(editor: ModelEditor, latest: TenantSettings, catalog: readonly CatalogModel[]): ModelEditor {
  const onto = buildModelDraft(latest);
  return {
    baseline: { version: latest.version, values: onto },
    draft: rebaseModelDraft(editor.baseline.values, editor.draft, onto, catalog),
    mergedFrom: editor.mergedFrom ?? editor.baseline.values
  };
}

/**
 * Take newer saved settings. A draft without edits takes them as they are. A
 * draft with edits is rebased when the newer version changed none of the
 * edited settings. Otherwise the editor stays as it is, and the administrator
 * keeps or discards the edits first. Returns the same editor when nothing
 * changes.
 */
export function followNewer(editor: ModelEditor, latest: TenantSettings, catalog: readonly CatalogModel[]): ModelEditor {
  if (latest.version <= editor.baseline.version) return editor;
  if (changedModelSettings(editor.baseline.values, editor.draft).length === 0) return startModelEditor(latest);
  if (conflictingModelSettings(editor.baseline.values, editor.draft, buildModelDraft(latest), catalog).length > 0) return editor;
  return keepEditsOn(editor, latest, catalog);
}

/** The editor after this administrator deleted a custom model (see removeModelFromDraft). */
export function removeModelFromEditor(editor: ModelEditor, modelId: string): ModelEditor {
  const { baseline, draft } = removeModelFromDraft(editor.baseline.values, editor.draft, modelId);
  return {
    baseline: { ...editor.baseline, values: baseline },
    draft,
    mergedFrom: editor.mergedFrom ? removeSavedModel(editor.mergedFrom, modelId) : null
  };
}

/** A saved model setting in words, with its value after the change. */
export type ModelSettingChange = { setting: ModelSetting; label: string; detail: string };

/** The changes between two saved versions, in the order of the page. */
export function describeModelChanges(from: ModelDraft, to: ModelDraft, catalog: readonly CatalogModel[]): ModelSettingChange[] {
  const name = (modelId: string) => catalog.find((model) => model.id === modelId)?.displayName ?? modelId;
  const providerNames = (providers: ModelProvider[]) => providers.map((provider) => MODEL_PROVIDER_META[provider].label).join(", ");
  const sentence = (parts: Array<string | null>) => parts.filter(Boolean).join(" ");
  // The order of the rows on the page. Effort overrides follow the effort selector.
  const order = (setting: ModelSetting) =>
    setting === "defaultModelId" ? 0 : setting === "enabledModelIds" ? 1 : setting === "showEffortSelector" ? 2 : setting === "enabledProviders" ? 4 : 3;

  return changedModelSettings(from, to)
    .sort((left, right) => order(left) - order(right))
    .map((setting): ModelSettingChange => {
      if (setting === "defaultModelId") {
        return { setting, label: "Default model", detail: to.defaultModelId ? `${name(to.defaultModelId)}.` : "Catalog default." };
      }
      if (setting === "enabledModelIds") {
        const before = selection(from);
        const after = selection(to);
        if (after === null) return { setting, label: "Available models", detail: "All models, also models added later." };
        if (before === null) {
          return { setting, label: "Available models", detail: `Only selected models: ${after.length ? after.map(name).join(", ") : "none"}.` };
        }
        const { added, removed } = setDelta(before, after);
        return {
          setting,
          label: "Available models",
          detail: sentence([
            added.length ? `Added: ${added.map(name).join(", ")}.` : null,
            removed.length ? `Removed: ${removed.map(name).join(", ")}.` : null
          ])
        };
      }
      if (setting === "showEffortSelector") {
        return { setting, label: "Effort in the chat picker", detail: to.showEffortSelector ? "Shown." : "Hidden." };
      }
      if (setting === "enabledProviders") {
        const { added, removed } = setDelta(from.enabledProviders, to.enabledProviders);
        return {
          setting,
          label: "Providers in use",
          detail: sentence([
            added.length ? `Turned on: ${providerNames(added)}.` : null,
            removed.length ? `Turned off: ${providerNames(removed)}.` : null
          ])
        };
      }
      const modelId = effortModelId(setting) ?? "";
      const effort = to.modelDefaultEfforts[modelId];
      return { setting, label: `Default effort for ${name(modelId)}`, detail: effort ? `${effort}.` : "The model's default." };
    });
}
