import { IntegrationRegistry } from "./integration-registry.js";
import type { AppConfig } from "../../config.js";
import { IntegrationOAuthStateStore } from "./integration-oauth-state-store.js";
import { IntegrationRegistryService } from "./integration-registry-service.js";
import { registerBuiltinIntegrations } from "./register-builtin-integrations.js";

import type { Stores } from "../build-stores.js";
import type { Redis } from "ioredis";

// Core integration services for one app. The connector modules and overlays
// attach their live hooks to `integrationDescriptors` later in
// `buildAppDependencies()`.
export function buildIntegrationServices(
  config: AppConfig,
  stores: Pick<Stores, "integrationStates">,
  redis?: Redis | null
) {
  const oauthStates = new IntegrationOAuthStateStore(redis);

  registerBuiltinIntegrations();
  const integrationDescriptors = new IntegrationRegistry();
  const integrationRegistry = new IntegrationRegistryService(config, stores.integrationStates, {}, integrationDescriptors);

  return {
    integrationDescriptors,
    // Shared single-use state store for the connector and overlay OAuth flows.
    oauthStates,
    integrationRegistry
  };
}
