import type { EffortLevel, ModelProvider } from "@cogniplane/shared-types";

import type { AvailableModel } from "./models.js";
import { AVAILABLE_MODELS } from "./models.js";

/**
 * Tenant-level model availability config (a slice of TenantSettingsRecord).
 * A model is selectable iff its provider is enabled AND (the model allowlist
 * is null OR contains the model id). Key presence is a separate, orthogonal
 * gate applied by callers — availability says "the admin allows this model",
 * key presence says "we can actually call it".
 */
export type ModelAvailabilitySettings = {
  enabledProviders: ModelProvider[];
  enabledModelIds: string[] | null;
  modelDefaultEfforts: Record<string, EffortLevel>;
};

export function isModelEnabled(
  model: AvailableModel,
  settings: ModelAvailabilitySettings
): boolean {
  if (!settings.enabledProviders.includes(model.provider)) return false;
  return settings.enabledModelIds === null || settings.enabledModelIds.includes(model.id);
}

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
