import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "./config.js";
import { type Pool } from "./lib/db.js";
import { attachOverlays, type OverlayHandles } from "./overlays.js";
import { ActiveTurnMessageMap } from "./services/active-turn-message-map.js";
import { buildBootstrapServices } from "./services/build-bootstrap-services.js";
import { buildStores } from "./services/build-stores.js";
import { RuntimeEgressIpPinStore } from "./services/runtime-egress-ip-pin.js";
import { buildIntegrationServices } from "./services/integrations/build-integration-services.js";
import type { RuntimeInvalidator } from "./services/integrations/contracts.js";
import { buildManagedToolRegistries } from "./services/managed-tools/build-managed-tools.js";
import { buildPiiServices } from "./services/pii/build-pii-services.js";
import { buildRuntimeAdapters } from "./services/runtime/build-runtime-adapters.js";

export { buildSchedulerWorker } from "./services/build-scheduler-worker.js";

export function buildAppDependencies(input: {
  db: Pool;
  schedulerDb?: Pool;
  privilegedDb?: Pool;
  config: AppConfig;
  logger: FastifyBaseLogger;
}) {
  const { db, schedulerDb = db, privilegedDb = db, config, logger } = input;

  const stores = buildStores(db, schedulerDb, privilegedDb, logger);
  const { managedToolCatalog, managedToolFactoryRegistry } = buildManagedToolRegistries();
  const bootstrap = buildBootstrapServices({
    config,
    db,
    privilegedDb,
    logger,
    stores,
    managedToolCatalog
  });

  // Construction-order inversion: integration connection services need a
  // `RuntimeInvalidator` at construction time, but the runtime manager (the
  // invalidator) needs the integration registry. The closure below resolves
  // to the runtime manager only when an integration actually invokes it,
  // which happens inside async OAuth/disconnect flows — long after all
  // construction is finished.
  let runtimeManagerRef: RuntimeInvalidator | null = null;
  const resolveRuntimeInvalidator = (): RuntimeInvalidator => {
    if (!runtimeManagerRef) {
      throw new Error(
        "buildAppDependencies: runtime manager was not yet wired when an integration tried to invalidate runtimes. " +
          "This indicates a wiring bug — integrations should never invalidate during composition, only inside async flows."
      );
    }
    return runtimeManagerRef;
  };

  const integrations = buildIntegrationServices(
    config,
    stores,
    resolveRuntimeInvalidator,
    bootstrap.limits
  );
  // Shared by /messages (sets at turn start, clears at end) and the LLM
  // proxy (looks up by rt_*'s sid+rid to charge usage to the right
  // assistant message). Single-process scope — see file docstring.
  const activeTurnMessageMap = new ActiveTurnMessageMap();
  // Per-runtime egress IP pin for /llm/* — first observed peer IP for a
  // runtimeId is recorded and subsequent calls must match. TTL aligned
  // with the rt_* token so eviction is handled by token expiry; the
  // runtime adapters additionally clear pins on explicit teardown.
  // Constructed here so the LLM proxy and the runtime adapters share
  // the same instance.
  const egressIpPins = new RuntimeEgressIpPinStore(config.RUNTIME_TOKEN_TTL_MS);

  const { runtimeManager, runtimeAdapters } = buildRuntimeAdapters({
    config,
    logger,
    stores,
    integrations,
    dynamicConfig: bootstrap.dynamicConfig,
    artifactStorage: bootstrap.artifactStorage,
    skillBundleStorage: bootstrap.skillBundleStorage,
    managedToolCatalog,
    getTenantAnthropicApiKey: bootstrap.getTenantAnthropicApiKey,
    getTenantOpenaiApiKey: bootstrap.getTenantOpenaiApiKey,
    egressIpPins
  });

  runtimeManagerRef = runtimeManager;

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
    runtimeInvalidator: integrations.runtimeInvalidator,
    managedToolCatalog,
    managedToolFactoryRegistry
  });

  return {
    db,
    sessions: stores.sessions,
    messages: stores.messages,
    artifacts: stores.artifacts,
    runtimeSessions: stores.runtimeSessions,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    mcpServers: stores.mcpServers,
    tenantSettings: stores.tenantSettings,
    userSettings: stores.userSettings,
    tenantMembers: stores.tenantMembers,
    githubConnections: stores.githubConnections,
    githubConnectionService: integrations.githubConnectionService,
    notionConnections: stores.notionConnections,
    notionConnectionService: integrations.notionConnectionService,
    integrationStates: stores.integrationStates,
    integrationRegistry: integrations.integrationRegistry,
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
    runtimeManager,
    runtimeAdapters,
    tenantOrgSettings: bootstrap.tenantOrgSettings,
    getTenantAnthropicApiKey: bootstrap.getTenantAnthropicApiKey,
    getTenantOpenaiApiKey: bootstrap.getTenantOpenaiApiKey,
    piiProtection: pii.piiProtection,
    piiCircuitBreaker: pii.piiCircuitBreaker,
    piiScanRuns: stores.piiScanRuns,
    piiScanJobs: stores.piiScanJobs,
    piiAnalytics: stores.piiAnalytics,
    piiScanJobHandler: pii.piiScanJobHandler,
    piiScanEnqueuer: pii.piiScanEnqueuer,
    activeTurns: stores.activeTurns,
    activeTurnMessageMap,
    egressIpPins,
    sessionRuntimeOverrides: stores.sessionRuntimeOverrides,
    overlays
  };
}

export type AppDependencies = ReturnType<typeof buildAppDependencies>;
