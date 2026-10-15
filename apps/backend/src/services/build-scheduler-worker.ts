import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import type { RuntimeAdapter } from "../runtime-contracts.js";
import type { AuditEventStore } from "./audit-event-store.js";
import type { DynamicConfigService } from "./dynamic-config-service.js";
import { toAvailableModel, type CustomModelStore } from "./custom-model-store.js";
import { AVAILABLE_MODELS } from "../domain/models.js";
import type { MessageStore } from "./message-store.js";
import type { PiiScanJobHandler } from "./pii/pii-scan-job-handler.js";
import type { PiiScanJobStore } from "./pii/pii-scan-job-store.js";
import { buildApiKeyPresenceCheckers } from "./runtime/api-key-presence.js";
import type { ProviderCredentials } from "./runtime/provider-credentials.js";
import { resolveRuntimeModel } from "./runtime/runtime-model-resolver.js";
import { SchedulerWorker, type SchedulerRuntimeResolution, type SchedulerWorkerDeps } from "./scheduler-worker.js";
import type { SessionStore } from "./session-store.js";
import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import type { UserSettingsStore } from "./user-settings-store.js";
import type { ProjectFileStore } from "./project-file-store.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";

/**
 * Resolve the runtime and model for a scheduled turn the way an interactive
 * turn does: the tenant's default model, its availability settings, and the
 * provider keys that are configured.
 */
export function schedulerRuntimeResolver(input: {
  runtimeAdapter: RuntimeAdapter;
  dynamicConfig: Pick<DynamicConfigService, "getOrCreateTenantSettings">;
  customModels: Pick<CustomModelStore, "list">;
  providerCredentials: ProviderCredentials;
}): (tenantId: string) => Promise<SchedulerRuntimeResolution> {
  const { hasProviderKey } = buildApiKeyPresenceCheckers({
    credentials: input.providerCredentials
  });

  return async (tenantId: string): Promise<SchedulerRuntimeResolution> => {
    const resolution = await resolveRuntimeModel({
      tenantId,
      // Scheduled jobs use the tenant's default model; the resolver gates on
      // that model's provider (not Anthropic specifically).
      requestedModel: undefined,
      requestedEffort: undefined,
      runtimeAdapter: input.runtimeAdapter,
      stores: {
        hasProviderKey,
        // Scheduled turns honor the same admin-controlled model availability
        // and default-effort overrides as interactive ones.
        getModelAvailability: (tenantId) =>
          input.dynamicConfig.getOrCreateTenantSettings(tenantId),
        listModels: async (tenantId) => [
          ...AVAILABLE_MODELS,
          ...(await input.customModels.list(tenantId)).map(toAvailableModel)
        ]
      }
    });

    if (resolution.kind === "error") {
      // The resolver speaks HTTP error envelopes; flatten to the most useful
      // human-readable string for the run ledger and audit trail.
      const message =
        resolution.body.message ??
        resolution.body.details?.map((d) => d.message).join("; ") ??
        resolution.body.error;
      return { kind: "error", message };
    }

    return {
      kind: "ok",
      adapter: resolution.runtimeAdapter,
      modelId: resolution.selectedModel?.id ?? null,
      effort: resolution.selectedEffort
    };
  };
}

export function buildSchedulerWorker(
  config: AppConfig,
  input: {
    userSettings: UserSettingsStore;
    sessions: SessionStore;
    messages: MessageStore;
    toolContexts: ToolExecutionContextStore;
    runtimeAdapter: RuntimeAdapter;
    dynamicConfig: DynamicConfigService;
    customModels: CustomModelStore;
    providerCredentials: ProviderCredentials;
    auditEvents: AuditEventStore;
    piiProtection?: SchedulerWorkerDeps["piiProtection"];
    piiScanRuns?: SchedulerWorkerDeps["piiScanRuns"];
    piiScanJobs?: PiiScanJobStore;
    piiScanJobHandler?: PiiScanJobHandler;
    projectFiles?: Pick<ProjectFileStore, "cleanupExpired">;
    projectFileStorage?: Pick<ArtifactStorage, "delete">;
    sessionTrash?: Pick<SessionStore, "cleanupExpired">;
    sessionStorage?: Pick<ArtifactStorage, "delete">;
    logger: FastifyBaseLogger;
  }
) {
  // The worker drives independent workloads: the cron scheduler, the async
  // PII scan-job drain, project-file retention, and session Trash retention.
  // Any one alone is reason enough to run it.
  //
  // The PII drain runs whenever its deps exist. The rule detector queues
  // artifact scans without the remote provider, so gating on
  // PII_PROVIDER_ENABLED would leave those uploads pending forever. The drain
  // claims jobs through the privileged pool, whose BYPASSRLS role app.ts
  // asserts at every boot.
  const piiDrainEnabled = Boolean(input.piiScanJobs && input.piiScanJobHandler);
  const projectRetentionEnabled =
    config.PROJECT_FILE_RETENTION_ENABLED &&
    Boolean(input.projectFiles && input.projectFileStorage);
  const sessionRetentionEnabled =
    config.SESSION_TRASH_RETENTION_ENABLED &&
    Boolean(input.sessionTrash && input.sessionStorage);
  if (!config.SCHEDULER_ENABLED && !piiDrainEnabled && !projectRetentionEnabled && !sessionRetentionEnabled) {
    return null;
  }

  const resolveRuntime = schedulerRuntimeResolver(input);

  return new SchedulerWorker(
    {
      settings: input.userSettings,
      sessions: input.sessions,
      messages: input.messages,
      toolContexts: input.toolContexts,
      resolveRuntime,
      auditEvents: input.auditEvents,
      piiProtection: input.piiProtection,
      piiScanRuns: input.piiScanRuns,
      // Without both PII deps, drainPiiScanJobs no-ops.
      piiScanJobs: piiDrainEnabled ? input.piiScanJobs : undefined,
      piiScanJobHandler: piiDrainEnabled ? input.piiScanJobHandler : undefined,
      projectFiles: projectRetentionEnabled ? input.projectFiles : undefined,
      projectFileStorage: projectRetentionEnabled ? input.projectFileStorage : undefined,
      sessionTrash: sessionRetentionEnabled ? input.sessionTrash : undefined,
      sessionStorage: sessionRetentionEnabled ? input.sessionStorage : undefined,
      runtimeAdapter: input.runtimeAdapter,
      // Poison-job disable is backed by UserSettingsStore.disableJob; thread it
      // in so the worker can permanently drop invalid-cron / repeatedly-failing
      // jobs instead of leaving them dormant.
      disableJob: async ({ tenantId, jobId }) => {
        await input.userSettings.disableJob(tenantId, jobId);
      },
      logger: input.logger
    },
    {
      schedulingEnabled: config.SCHEDULER_ENABLED,
      maxConcurrentJobs: config.SCHEDULER_MAX_CONCURRENT_JOBS,
      maxConcurrentPiiJobs: config.PII_SCAN_MAX_CONCURRENT_JOBS,
      jobTimeoutMs: config.SCHEDULER_JOB_TIMEOUT_MS,
      maxConsecutiveFailures: config.SCHEDULER_MAX_CONSECUTIVE_FAILURES
    }
  );
}
