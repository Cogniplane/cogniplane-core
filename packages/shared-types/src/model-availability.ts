import type { Model } from "./schemas/settings.js";
import type { TenantSettings } from "./schemas/tenant.js";

/** Tenant policy only. Callers must also check the selected provider's credentials. */
export function isModelEnabled(
  model: Pick<Model, "id" | "provider">,
  settings: Pick<TenantSettings, "enabledProviders" | "enabledModelIds">
): boolean {
  if (!settings.enabledProviders.includes(model.provider)) return false;
  // null allows all models; an empty list allows none.
  return settings.enabledModelIds === null || settings.enabledModelIds.includes(model.id);
}
