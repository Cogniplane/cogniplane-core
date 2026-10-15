import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "./config.js";
import { type Pool } from "./lib/db.js";
import type { OverlayHandles } from "./overlay-contracts.js";
import { attachOverlays } from "./overlays.js";
import { buildBootstrapServices } from "./services/build-bootstrap-services.js";
import { buildStores } from "./services/build-stores.js";
import { ProxyToolMetadataCache } from "./services/mcp/proxy-tool-metadata-cache.js";
import { McpConnectionTestService } from "./services/mcp/mcp-connection-test-service.js";
import { buildIntegrationServices } from "./services/integrations/build-integration-services.js";
import { loadIntegrationEnablement } from "./services/integrations/integration-enablement.js";
import { buildManagedToolRegistries } from "./services/managed-tools/build-managed-tools.js";
import { buildPiiServices } from "./services/pii/build-pii-services.js";
import { UploadAdmission } from "./services/artifacts/upload-admission.js";
import { RedisPolicyInvalidationBus } from "./services/policy/policy-cache-invalidation.js";
import { PolicyService } from "./services/policy/policy-service.js";
import { buildRuntimeAdapter } from "./services/runtime/build-runtime-adapters.js";
import { TurnCoordinationBus } from "./services/turn-coordination-bus.js";

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
  const mcpConnectionTests = new McpConnectionTestService({
    db,
    servers: stores.mcpServers,
    credentials: stores.memberMcpCredentials,
    timeoutMs: config.MCP_CONNECTION_TEST_TIMEOUT_MS,
    logger
  });

  const bootstrap = buildBootstrapServices({
    config,
    db,
    privilegedDb,
    logger,
    stores,
    managedToolCatalog
  });
  const turnBus = bootstrap.redis ? new TurnCoordinationBus(bootstrap.redis) : undefined;
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
    config, stores, deepAgentsAdapter, bootstrap.limits, bootstrap.redis, logger
  );
  bootstrap.dynamicConfig.setIntegrationToolSource(integrations.integrationRegistry);
  const proxyToolMetadataCache = new ProxyToolMetadataCache(logger);

  // PII scans read a PDF through its extracted text.
  const extractPdfText = (pdf: Buffer, signal?: AbortSignal) =>
    bootstrap.artifactProcessor.extractPdfText(pdf, signal);
  const pii = buildPiiServices({
    config,
    logger,
    db,
    stores,
    artifactStorage: bootstrap.artifactStorage,
    tenantOrgSettingsPrivileged: bootstrap.tenantOrgSettingsPrivileged,
    redis: bootstrap.redis,
    extractPdfText
  });
  stores.projectFiles.setPiiProtection(pii.piiProtection, extractPdfText);

  // Attach optional overlays through the core-owned contract in
  // `overlay-contracts.ts`. The OSS tree ships a no-op implementation.
  const overlays: OverlayHandles = attachOverlays({
    config: {
      API_ORIGIN: config.API_ORIGIN,
      DATA_ENCRYPTION_SECRET: config.DATA_ENCRYPTION_SECRET,
      JWT_SECRET: config.JWT_SECRET,
      JWT_KEY_ID: config.JWT_KEY_ID,
      JWT_VERIFICATION_KEYS: config.JWT_VERIFICATION_KEYS,
      ARTIFACT_MAX_UPLOAD_BYTES: config.ARTIFACT_MAX_UPLOAD_BYTES
    },
    db,
    uploadAdmission: new UploadAdmission({
      sessions: stores.sessions,
      artifacts: stores.artifacts,
      storage: bootstrap.artifactStorage,
      auditEvents: stores.auditEvents,
      piiScanEnqueuer: pii.piiScanEnqueuer,
      logger
    }),
    stores: {
      auditEvents: stores.auditEvents,
      integrationStates: stores.integrationStates
    },
    integrationDescriptors: integrations.integrationDescriptors,
    loadIntegrationEnablement: (tenantId, integrationId) =>
      loadIntegrationEnablement(stores.integrationStates, config, tenantId, integrationId),
    oauthStates: integrations.oauthStates,
    runtimeInvalidator: deepAgentsAdapter,
    managedToolCatalog,
    managedToolFactoryRegistry,
    limits: bootstrap.limits
  });

  return {
    db,
    projects: stores.projects,
    personalCapabilities: stores.personalCapabilities,
    personalSkills: stores.personalSkills,
    organizationSkillSubmissions: stores.organizationSkillSubmissions,
    skillReleaseImpact: stores.skillReleaseImpact,
    projectSkills: stores.projectSkills,
    memberMcpCredentials: stores.memberMcpCredentials,
    projectFiles: stores.projectFiles,
    projectMembers: stores.projectMembers,
    executions: stores.executions,
    sessions: stores.sessions,
    messages: stores.messages,
    modelSpending: stores.modelSpending,
    memories: stores.memories,
    artifacts: stores.artifacts,
    runtimeSessions: stores.runtimeSessions,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    mcpServers: stores.mcpServers,
    mcpAppCsp: stores.mcpAppCsp,
    mcpConnectionTests,
    tenantSettings: stores.tenantSettings,
    customModels: stores.customModels,
    userSettings: stores.userSettings,
    tenantMembers: stores.tenantMembers,
    githubConnections: stores.githubConnections,
    githubConnectionService: integrations.githubConnectionService,
    notionConnections: stores.notionConnections,
    notionConnectionService: integrations.notionConnectionService,
    jiraConnectionService: integrations.jiraConnectionService,
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
    turnBus,
    proxyToolMetadataCache,
    policyRules: stores.policyRules,
    policyDecisions: stores.policyDecisions,
    policyService,
    overlays
  };
}

export type AppDependencies = ReturnType<typeof buildAppDependencies>;
