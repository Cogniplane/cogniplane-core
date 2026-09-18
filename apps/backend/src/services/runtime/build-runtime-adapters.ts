import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import { createDeepAgentsCheckpointer } from "../deep-agents/deep-agents-checkpointer.js";
import { DeepAgentsRuntimeAdapter } from "../deep-agents/deep-agents-runtime-adapter.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { PolicyService } from "../policy/policy-service.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";
import type { ProviderCredentials } from "./provider-credentials.js";

import type { Stores } from "../build-stores.js";

export function buildRuntimeAdapter(input: {
  config: AppConfig;
  logger: FastifyBaseLogger;
  stores: Stores;
  dynamicConfig: DynamicConfigService;
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
      executions: stores.executions,
      conversationMessages: stores.messages,
      sessions: stores.sessions,
      auditEvents: stores.auditEvents,
      activationTracker: stores.activationTracker,
      runtimeSessions: stores.runtimeSessions,
      memories: stores.memories,
      policyService,
      checkpointer: createDeepAgentsCheckpointer(config.DATABASE_URL),
      // In-process usage/cost accounting (each provider's API is called
      // directly from the backend).
      messages: stores.messages,
      // Materializes bundle companion files into the /skills/ library.
      skillBundles: skillBundleStorage,
      tenantMembers: stores.tenantMembers
    },
    providerCredentials,
    undefined,
    managedToolCatalog
  );

  return { deepAgentsAdapter };
}
