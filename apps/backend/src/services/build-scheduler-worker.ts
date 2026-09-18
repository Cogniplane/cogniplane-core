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
import { SchedulerWorker, type SchedulerRuntimeResolution } from "./scheduler-worker.js";
import type { SessionStore } from "./session-store.js";
import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import type { UserSettingsStore } from "./user-settings-store.js";
import type { ProjectFileStore } from "./project-file-store.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";

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
  // The PII drain claims jobs cross-tenant through the privileged (BYPASSRLS)
  // pool. That pool's BYPASSRLS contract is asserted at boot ONLY when
  // PII_PROVIDER_ENABLED (or SCHEDULER_ENABLED / workos) is set — see the
  // privilegedNeedsBypassRls check in app.ts. So the drain is only safe to run
  // when PII_PROVIDER_ENABLED is true; running it otherwise would query an
  // RLS-bound pool and silently claim zero rows, leaving jobs queued forever.
  // We therefore gate the PII half on PII_PROVIDER_ENABLED, not merely on the
  // deps being present (they always are). This keeps boot-time validation and
  // the worker's runtime behavior in lockstep.
  const piiDrainEnabled =
    config.PII_PROVIDER_ENABLED && Boolean(input.piiScanJobs && input.piiScanJobHandler);
  const projectRetentionEnabled =
    config.PROJECT_FILE_RETENTION_ENABLED &&
    Boolean(input.projectFiles && input.projectFileStorage);
  const sessionRetentionEnabled =
    config.SESSION_TRASH_RETENTION_ENABLED &&
    Boolean(input.sessionTrash && input.sessionStorage);
  if (!config.SCHEDULER_ENABLED && !piiDrainEnabled && !projectRetentionEnabled && !sessionRetentionEnabled) {
    return null;
  }

  const { hasProviderKey } = buildApiKeyPresenceCheckers({
    credentials: input.providerCredentials
  });

  const resolveRuntime = async (tenantId: string): Promise<SchedulerRuntimeResolution> => {
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

  return new SchedulerWorker(
    {
      settings: input.userSettings,
      sessions: input.sessions,
      messages: input.messages,
      toolContexts: input.toolContexts,
      resolveRuntime,
      auditEvents: input.auditEvents,
      // Only thread the PII drain in when it's safe to run (see above); when
      // disabled, the worker's drainPiiScanJobs no-ops because the deps are
      // absent, so a scheduler-only worker never touches the PII queue.
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
