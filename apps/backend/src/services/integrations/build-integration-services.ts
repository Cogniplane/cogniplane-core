import { IntegrationRegistry } from "./integration-registry.js";
import type { AppConfig } from "../../config.js";
import type { RequestLimitsInterface } from "../request-limits.js";
import type { RuntimeInvalidator } from "./contracts.js";
import { IntegrationOAuthStateStore } from "./integration-oauth-state-store.js";
import { GithubConnectionService } from "./github/github-connection-service.js";
import { IntegrationRegistryService } from "./integration-registry-service.js";
import { NotionConnectionService } from "./notion/notion-connection-service.js";
import {
  attachBuiltinIntegrationRuntime,
  registerBuiltinIntegrations
} from "./register-builtin-integrations.js";

import type { Stores } from "../build-stores.js";
import type { Redis } from "ioredis";

export function buildIntegrationServices(
  config: AppConfig,
  stores: Stores,
  runtimeInvalidator: RuntimeInvalidator,
  // Rate limiter applied (per-IP) to the unauthenticated OAuth callback routes.
  limits?: RequestLimitsInterface,
  redis?: Redis | null
) {
  const oauthStates = new IntegrationOAuthStateStore(redis);
  const githubConnectionService = new GithubConnectionService(
    config,
    stores.githubConnections,
    stores.auditEvents,
    runtimeInvalidator,
    oauthStates
  );
  const notionConnectionService = new NotionConnectionService(
    config,
    stores.notionConnections,
    stores.auditEvents,
    runtimeInvalidator,
    oauthStates
  );

  registerBuiltinIntegrations();
  const integrationDescriptors = new IntegrationRegistry();
  attachBuiltinIntegrationRuntime(integrationDescriptors, {
    probes: {
      notion: notionConnectionService,
      github: githubConnectionService
    },
    oauth: {
      notion: notionConnectionService,
      github: githubConnectionService
    },
    limits
  });

  const integrationRegistry = new IntegrationRegistryService(config, stores.integrationStates, {}, integrationDescriptors);

  return {
    integrationDescriptors,
    githubConnectionService,
    notionConnectionService,
    integrationRegistry
  };
}
