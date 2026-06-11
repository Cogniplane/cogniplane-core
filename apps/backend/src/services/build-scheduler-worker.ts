import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import type { RuntimeAdapter } from "../runtime-contracts.js";
import type { RuntimeProvider } from "./admin-config-records.js";
import type { AuditEventStore } from "./audit-event-store.js";
import type { DynamicConfigService } from "./dynamic-config-service.js";
import type { MessageStore } from "./message-store.js";
import type { PiiScanJobHandler } from "./pii/pii-scan-job-handler.js";
import type { PiiScanJobStore } from "./pii/pii-scan-job-store.js";
import { buildApiKeyPresenceCheckers } from "./runtime/api-key-presence.js";
import { resolveRuntimeProviderAndModel } from "./runtime/runtime-provider-resolver.js";
import { SchedulerWorker, type SchedulerRuntimeResolution } from "./scheduler-worker.js";
import type { SessionStore } from "./session-store.js";
import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import type { UserSettingsStore } from "./user-settings-store.js";

export function buildSchedulerWorker(
  config: AppConfig,
  input: {
    userSettings: UserSettingsStore;
    sessions: SessionStore;
    messages: MessageStore;
    toolContexts: ToolExecutionContextStore;
    runtimeManager: RuntimeAdapter;
    runtimeAdapters: Partial<Record<RuntimeProvider, RuntimeAdapter>>;
    dynamicConfig: DynamicConfigService;
    getTenantAnthropicApiKey: (tenantId: string) => Promise<string | null>;
    getTenantOpenaiApiKey: (tenantId: string) => Promise<string | null>;
    auditEvents: AuditEventStore;
    piiScanJobs?: PiiScanJobStore;
    piiScanJobHandler?: PiiScanJobHandler;
    logger: FastifyBaseLogger;
  }
) {
  // The worker drives two independent workloads: the cron scheduler and the
  // async PII scan-job drain. Either one alone is reason enough to run it.
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
  if (!config.SCHEDULER_ENABLED && !piiDrainEnabled) {
    return null;
  }

  const { hasAnthropicApiKey, hasOpenaiApiKey } = buildApiKeyPresenceCheckers({
    config,
    getTenantAnthropicApiKey: input.getTenantAnthropicApiKey,
    getTenantOpenaiApiKey: input.getTenantOpenaiApiKey
  });

  const resolveRuntime = async (tenantId: string): Promise<SchedulerRuntimeResolution> => {
    const resolution = await resolveRuntimeProviderAndModel({
      tenantId,
      requestedModel: undefined,
      requestedEffort: undefined,
      defaultAdapter: input.runtimeManager,
      stores: {
        dynamicConfig: input.dynamicConfig,
        runtimeAdapters: input.runtimeAdapters,
        hasAnthropicApiKey,
        hasOpenaiApiKey
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
      provider: resolution.provider,
      modelId: resolution.selectedModel?.id ?? null
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
