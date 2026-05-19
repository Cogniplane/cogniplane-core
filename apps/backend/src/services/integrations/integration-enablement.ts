import type { AppConfig } from "../../config.js";
import { getPlatformStatus } from "./integration-registry-service.js";
import type { IntegrationStateStore } from "./integration-state-store.js";

// Resolves the per-tenant integration row + the platform-configuration
// status into the shape the connection-status endpoints (`/me/<x>-connection`)
// merge into their response. Shared between core (GitHub, Notion) and the
// SharePoint private overlay (Microsoft).

export type IntegrationEnablement = {
  tenantEnabled: boolean;
  tenantReadsEnabled: boolean;
  tenantWritesEnabled: boolean;
  platformConfigured: boolean;
};

export async function loadIntegrationEnablement(
  integrationStates: IntegrationStateStore,
  config: AppConfig,
  tenantId: string,
  integrationId: string
): Promise<IntegrationEnablement> {
  const state = await integrationStates.get(tenantId, integrationId);
  const platform = getPlatformStatus(integrationId, config);
  const reads = state?.readsEnabled ?? false;
  const writes = state?.writesEnabled ?? false;
  return {
    tenantEnabled: reads || writes,
    tenantReadsEnabled: reads,
    tenantWritesEnabled: writes,
    platformConfigured: platform.configured
  };
}
