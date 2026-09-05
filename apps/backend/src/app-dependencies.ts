import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "./config.js";
import { type Pool } from "./lib/db.js";
import { attachOverlays, type OverlayHandles } from "./overlays.js";
import { buildBootstrapServices } from "./services/build-bootstrap-services.js";
import { buildStores } from "./services/build-stores.js";
import { ProxyToolMetadataCache } from "./services/mcp/proxy-tool-metadata-cache.js";
import { buildIntegrationServices } from "./services/integrations/build-integration-services.js";
import { buildManagedToolRegistries } from "./services/managed-tools/build-managed-tools.js";
import { buildPiiServices } from "./services/pii/build-pii-services.js";
import { RedisPolicyInvalidationBus } from "./services/policy/policy-cache-invalidation.js";
import { PolicyService } from "./services/policy/policy-service.js";
import { buildRuntimeAdapter } from "./services/runtime/build-runtime-adapters.js";

export { buildSchedulerWorker } from "./services/build-scheduler-worker.js";

export function buildAppDependencies(input: {
  db: Pool;
  schedulerDb?: Pool;
  privilegedDb?: Pool;
  config: AppConfig;
  logger: FastifyBaseLogger;
}) {
  const { db, schedulerDb = db, privilegedDb = db, config, logger } = input;

  const stores = buildStores(db, schedulerDb, privilegedDb, logger, config);
  const { managedToolCatalog, managedToolFactoryRegistry } = buildManagedToolRegistries();

  const bootstrap = buildBootstrapServices({
    config,
    db,
    privilegedDb,
    logger,
    stores,
    managedToolCatalog
  });
  // Policy Center — runtime rule engine. Redis pub/sub evicts cached rule sets
  // across replicas after admin mutations; the short TTL remains a fallback
  // for local deployments and transient Redis disconnects.
  const policyService = new PolicyService({
    rules: stores.policyRules,
    decisions: stores.policyDecisions,
    auditEvents: stores.auditEvents,
    logger,
    invalidationBus: bootstrap.redis
      ? new RedisPolicyInvalidationBus(bootstrap.redis, logger)
      : undefined
  });

  const { deepAgentsAdapter } = buildRuntimeAdapter({
    config,
    logger,
    stores,
    dynamicConfig: bootstrap.dynamicConfig,
    skillBundleStorage: bootstrap.skillBundleStorage,
    managedToolCatalog,
    providerCredentials: bootstrap.providerCredentials,
    policyService
  });

  const integrations = buildIntegrationServices(
    config, stores, deepAgentsAdapter, bootstrap.limits, bootstrap.redis
  );
  const proxyToolMetadataCache = new ProxyToolMetadataCache();

  const pii = buildPiiServices({
    config,
    logger,
    db,
    stores,
    artifactStorage: bootstrap.artifactStorage,
    tenantOrgSettingsPrivileged: bootstrap.tenantOrgSettingsPrivileged,
    redis: bootstrap.redis
  });

  // Attach optional overlays. The core OSS tree ships a no-op implementation;
  // derived distributions can wire additional services, descriptors, managed
  // tools, and route attachers here.
  const overlays: OverlayHandles = attachOverlays({
    config,
    db,
    artifactStorage: bootstrap.artifactStorage,
    stores: {
      artifacts: stores.artifacts,
      auditEvents: stores.auditEvents,
      integrationStates: stores.integrationStates,
      sessions: stores.sessions
    },
    piiScanEnqueuer: pii.piiScanEnqueuer,
    integrationDescriptors: integrations.integrationDescriptors,
    runtimeInvalidator: deepAgentsAdapter,
    managedToolCatalog,
    managedToolFactoryRegistry
  });

  return {
    db,
    sessions: stores.sessions,
    messages: stores.messages,
    memories: stores.memories,
    artifacts: stores.artifacts,
    runtimeSessions: stores.runtimeSessions,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    mcpServers: stores.mcpServers,
    tenantSettings: stores.tenantSettings,
    customModels: stores.customModels,
    userSettings: stores.userSettings,
    tenantMembers: stores.tenantMembers,
    githubConnections: stores.githubConnections,
    githubConnectionService: integrations.githubConnectionService,
    notionConnections: stores.notionConnections,
    notionConnectionService: integrations.notionConnectionService,
    integrationStates: stores.integrationStates,
    integrationRegistry: integrations.integrationRegistry,
    integrationDescriptors: integrations.integrationDescriptors,
    approvals: stores.approvals,
    auditEvents: stores.auditEvents,
    platformEvents: stores.platformEvents,
    activationTracker: stores.activationTracker,
    toolEvents: stores.toolEvents,
    toolContexts: stores.toolContexts,
    skillBundleStorage: bootstrap.skillBundleStorage,
    skillMarketplace: bootstrap.skillMarketplace,
    dynamicConfig: bootstrap.dynamicConfig,
    managedToolCatalog,
    managedToolFactoryRegistry,
    limits: bootstrap.limits,
    artifactStorage: bootstrap.artifactStorage,
    artifactProcessor: bootstrap.artifactProcessor,
    runtimeAdapter: deepAgentsAdapter,
    // The same adapter exposed concretely for the admin/health routes that
    // call methods not on the RuntimeAdapter interface (getHealthSnapshot,
    // getRuntimeHealthDetail, invalidateTenantRuntimes). Generic routing goes
    // through `runtimeAdapter` above.
    deepAgentsAdapter,
    tenantOrgSettings: bootstrap.tenantOrgSettings,
    getTenantAnthropicApiKey: bootstrap.getTenantAnthropicApiKey,
    getTenantProviderKey: bootstrap.getTenantProviderKey,
    providerCredentials: bootstrap.providerCredentials,
    piiProtection: pii.piiProtection,
    piiCircuitBreaker: pii.piiCircuitBreaker,
    piiScanRuns: stores.piiScanRuns,
    piiScanJobs: stores.piiScanJobs,
    piiAnalytics: stores.piiAnalytics,
    piiScanJobHandler: pii.piiScanJobHandler,
    piiScanEnqueuer: pii.piiScanEnqueuer,
    activeTurns: stores.activeTurns,
    proxyToolMetadataCache,
    policyRules: stores.policyRules,
    policyDecisions: stores.policyDecisions,
    policyService,
    overlays
  };
}

export type AppDependencies = ReturnType<typeof buildAppDependencies>;
