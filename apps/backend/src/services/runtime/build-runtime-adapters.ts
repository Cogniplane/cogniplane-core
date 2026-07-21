import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import { createDeepAgentsCheckpointer } from "../deep-agents/deep-agents-checkpointer.js";
import { DeepAgentsRuntimeAdapter } from "../deep-agents/deep-agents-runtime-adapter.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { PolicyService } from "../policy/policy-service.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";
import type { ProviderCredentials } from "./provider-credentials.js";

import type { Stores } from "../build-stores.js";
import type { IntegrationServices } from "../integrations/build-integration-services.js";

export function buildRuntimeAdapter(input: {
  config: AppConfig;
  logger: FastifyBaseLogger;
  stores: Stores;
  integrations: IntegrationServices;
  dynamicConfig: DynamicConfigService;
  artifactStorage: ArtifactStorage;
  skillBundleStorage: SkillBundleStorage;
  managedToolCatalog: ManagedToolCatalog;
  providerCredentials: ProviderCredentials;
  /** Gates the workspace memory-injection read like a memory_search call. */
  policyService?: Pick<PolicyService, "evaluate">;
}) {
  const {
    config,
    logger,
    stores,
    dynamicConfig,
    managedToolCatalog,
    providerCredentials,
    policyService,
    skillBundleStorage
  } = input;

  // Deep Agents (bead quap): the sole runtime provider — an in-process
  // deepagentsjs loop across the configured model providers. The durable
  // checkpointer connects as app_user; its DDL ran from migrate.ts (see
  // deep-agents-checkpointer.ts for the tenant-isolation boundary).
  const deepAgentsAdapter = new DeepAgentsRuntimeAdapter(
    config,
    dynamicConfig,
    logger,
    {
      approvals: stores.approvals,
      auditEvents: stores.auditEvents,
      runtimeSessions: stores.runtimeSessions,
      memories: stores.memories,
      policyService,
      checkpointer: createDeepAgentsCheckpointer(config.DATABASE_URL),
      // In-process usage/cost accounting (each provider's API is called
      // directly from the backend).
      messages: stores.messages,
      // Materializes bundle companion files into the /skills/ library.
      skillBundles: skillBundleStorage
    },
    providerCredentials,
    undefined,
    managedToolCatalog
  );

  return { deepAgentsAdapter };
}
