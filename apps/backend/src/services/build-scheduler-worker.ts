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
  if (!config.SCHEDULER_ENABLED) {
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
      piiScanJobs: input.piiScanJobs,
      piiScanJobHandler: input.piiScanJobHandler,
      logger: input.logger
    },
    {
      maxConcurrentJobs: config.SCHEDULER_MAX_CONCURRENT_JOBS,
      jobTimeoutMs: config.SCHEDULER_JOB_TIMEOUT_MS
    }
  );
}
