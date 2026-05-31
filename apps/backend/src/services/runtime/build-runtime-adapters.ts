import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import type { RuntimeAdapter } from "../../runtime-contracts.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import { ClaudeCodeRuntimeAdapter } from "../claude/claude-code-runtime-adapter.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import { CodexRuntimeManager } from "../runtime-manager.js";
import { buildE2bCodexFactories } from "./e2b-runtime-process.js";
import type { RuntimeProvider } from "../admin-config-records.js";
import type { RuntimeEgressIpPinStore } from "../runtime-egress-ip-pin.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";

import type { Stores } from "../build-stores.js";
import type { IntegrationServices } from "../integrations/build-integration-services.js";

export function buildRuntimeAdapters(input: {
  config: AppConfig;
  logger: FastifyBaseLogger;
  stores: Stores;
  integrations: IntegrationServices;
  dynamicConfig: DynamicConfigService;
  artifactStorage: ArtifactStorage;
  skillBundleStorage: SkillBundleStorage;
  managedToolCatalog: ManagedToolCatalog;
  getTenantAnthropicApiKey: (tenantId: string) => Promise<string | null>;
  getTenantOpenaiApiKey: (tenantId: string) => Promise<string | null>;
  egressIpPins: RuntimeEgressIpPinStore;
}) {
  const {
    config,
    logger,
    stores,
    integrations,
    dynamicConfig,
    artifactStorage,
    skillBundleStorage,
    managedToolCatalog,
    getTenantAnthropicApiKey,
    getTenantOpenaiApiKey,
    egressIpPins
  } = input;

  // E2B is the only execution backend (config.ts requires E2B_API_KEY at boot),
  // so the Codex process + workspace factories are always sandbox-backed.
  const e2bFactories = buildE2bCodexFactories(config);

  const runtimeManager = new CodexRuntimeManager({
    config,
    dynamicConfig,
    logger,
    runtimeSessions: stores.runtimeSessions,
    approvals: stores.approvals,
    auditEvents: stores.auditEvents,
    toolEvents: stores.toolEvents,
    artifacts: stores.artifacts,
    storage: artifactStorage,
    skillBundleStorage,
    managedToolCatalog,
    isBetaTester: stores.tenantMembers.isUserBetaTester.bind(stores.tenantMembers),
    githubConnections: integrations.githubConnectionService,
    integrationRegistry: integrations.integrationRegistry,
    processFactory: e2bFactories.processFactory,
    workspaceFactory: e2bFactories.workspaceFactory,
    getTenantApiKey: getTenantOpenaiApiKey,
    activationTracker: stores.activationTracker,
    egressIpPins
  });

  // E2B_API_KEY is guaranteed present (config.ts fails fast otherwise), so the
  // Claude runtime always runs inside the sandbox.
  const claudeE2bOptions = {
    // Non-null: config.ts throws at boot when E2B_API_KEY is unset.
    apiKey: config.E2B_API_KEY!,
    templateId: config.E2B_TEMPLATE_ID,
    sandboxTimeoutMs: config.E2B_SANDBOX_TIMEOUT_MS
  };

  const claudeAdapter = new ClaudeCodeRuntimeAdapter(
    config,
    dynamicConfig,
    logger,
    managedToolCatalog,
    {
      approvals: stores.approvals,
      runtimeSessions: stores.runtimeSessions,
      auditEvents: stores.auditEvents,
      egressIpPins
    },
    getTenantAnthropicApiKey,
    claudeE2bOptions,
    integrations.integrationRegistry,
    stores.activationTracker
  );

  const runtimeAdapters: Partial<Record<RuntimeProvider, RuntimeAdapter>> = {
    codex: runtimeManager,
    "claude-code": claudeAdapter
  };

  return { runtimeManager, runtimeAdapters };
}
