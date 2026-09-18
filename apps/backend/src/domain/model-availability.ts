import type { EffortLevel, TenantSettings } from "@cogniplane/shared-types";
import { isModelEnabled } from "@cogniplane/shared-types";

import type { AvailableModel } from "./models.js";
import { AVAILABLE_MODELS } from "./models.js";

export type ModelAvailabilitySettings = Pick<
  TenantSettings,
  "enabledProviders" | "enabledModelIds" | "modelDefaultEfforts"
>;

/**
 * Filters `models` (defaults to the static catalog; pass the tenant-merged
 * list to include admin-added custom models) down to the enabled ones.
 */
export function listEnabledModels(
  settings: ModelAvailabilitySettings,
  models: readonly AvailableModel[] = AVAILABLE_MODELS
): AvailableModel[] {
  return models.filter((model) => isModelEnabled(model, settings));
}

/**
 * The model's effective default effort: the tenant override when it is valid
 * for the model, else the catalog default. An override for an effort the model
 * doesn't support (e.g. saved before a catalog change) is ignored, not errored.
 */
export function effectiveDefaultEffort(
  model: AvailableModel,
  settings: ModelAvailabilitySettings
): EffortLevel | null {
  const override = settings.modelDefaultEfforts[model.id];
  if (override && model.supportedEfforts.includes(override)) return override;
  return model.defaultEffort;
}

/** A copy of the model record with the tenant's default effort applied. */
export function withEffectiveDefaultEffort(
  model: AvailableModel,
  settings: ModelAvailabilitySettings
): AvailableModel {
  return { ...model, defaultEffort: effectiveDefaultEffort(model, settings) };
}

/**
 * Drop unavailable IDs so admin forms can save after a catalog removal.
 * If every selected model is gone, restore the unrestricted allowlist.
 * Preserve an explicitly empty list, which disables all models.
 * GET normalizes its response; custom-model deletion persists the result.
 */
export function pruneUnknownModelIds<T extends { enabledModelIds: string[] | null }>(
  settings: T,
  knownModelIds: ReadonlySet<string>
): T {
  if (settings.enabledModelIds === null) return settings;
  const kept = settings.enabledModelIds.filter((id) => knownModelIds.has(id));
  if (kept.length === settings.enabledModelIds.length) return settings;
  return { ...settings, enabledModelIds: kept.length > 0 ? kept : null };
}
