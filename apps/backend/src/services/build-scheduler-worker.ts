import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import type { AuditEventStore } from "./audit-event-store.js";
import type { MessageStore } from "./message-store.js";
import type { PiiScanJobHandler } from "./pii/pii-scan-job-handler.js";
import type { PiiScanJobStore } from "./pii/pii-scan-job-store.js";
import type { CodexRuntimeManager } from "./runtime-manager.js";
import { SchedulerWorker } from "./scheduler-worker.js";
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
    runtimeManager: CodexRuntimeManager;
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

  return new SchedulerWorker(
    {
      settings: input.userSettings,
      sessions: input.sessions,
      messages: input.messages,
      toolContexts: input.toolContexts,
      runtimeManager: input.runtimeManager,
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
