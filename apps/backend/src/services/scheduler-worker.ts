
import type { FastifyBaseLogger } from "fastify";
import { uuidv7 } from "../lib/uuid.js";

import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import type { AuditEventStore } from "./audit-event-store.js";
import { computeNextCronRunAt } from "../lib/cron.js";
import type { MessageStore } from "./message-store.js";
import type { PiiScanJobHandler } from "./pii/pii-scan-job-handler.js";
import type { PiiScanJobRecord, PiiScanJobStore } from "./pii/pii-scan-job-store.js";
import type { CodexRuntimeManager } from "./runtime-manager.js";
import type { SessionStore } from "./session-store.js";
import type { ScheduledJobRecord, UserSettingsStore } from "./user-settings-store.js";

export type SchedulerWorkerDeps = {
  settings: UserSettingsStore;
  sessions: SessionStore;
  messages: MessageStore;
  toolContexts: ToolExecutionContextStore;
  runtimeManager: CodexRuntimeManager;
  auditEvents: AuditEventStore;
  /**
   * Optional PII scan subsystem. When both are provided, each worker tick also
   * drains up to `maxConcurrentPiiJobs` queued `pii_scan_jobs` in parallel with
   * scheduled cron jobs. Kept optional so existing bootstrap paths and tests
   * that don't care about PII don't have to wire it.
   */
  piiScanJobs?: PiiScanJobStore;
  piiScanJobHandler?: PiiScanJobHandler;
  logger: FastifyBaseLogger;
};

export type SchedulerWorkerOptions = {
  maxConcurrentJobs: number;
  jobTimeoutMs: number;
  maxConcurrentPiiJobs?: number;
};

export class SchedulerWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private activeCount = 0;
  private activePiiCount = 0;

  constructor(
    private readonly deps: SchedulerWorkerDeps,
    private readonly options: SchedulerWorkerOptions
  ) {}

  start(intervalMs: number): void {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      this.tick().catch((error) => {
        this.deps.logger.error({ error }, "SchedulerWorker tick failed");
      });
    }, intervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async tick(): Promise<void> {
    const executions: Promise<void>[] = [];

    const available = this.options.maxConcurrentJobs - this.activeCount;
    if (available > 0) {
      const dueJobs = await this.deps.settings.listDueJobs(available);

      for (const job of dueJobs) {
        let nextRunAt: string | null;
        try {
          nextRunAt = computeNextCronRunAt(job.cronExpression, job.timeZone);
        } catch (error) {
          this.deps.logger.error(
            { error, jobId: job.jobId, cronExpression: job.cronExpression, timeZone: job.timeZone },
            "Scheduled job has invalid cron expression; claiming without rescheduling"
          );
          nextRunAt = null;
        }

        const claimed = await this.deps.settings.claimJob(job.jobId, nextRunAt);
        if (!claimed) {
          continue;
        }

        this.activeCount += 1;
        executions.push(
          this.executeJobWithTimeout(claimed).finally(() => {
            this.activeCount -= 1;
          })
        );
      }
    }

    await this.drainPiiScanJobs(executions);

    await Promise.allSettled(executions);
  }

  private async drainPiiScanJobs(executions: Promise<void>[]): Promise<void> {
    const { piiScanJobs, piiScanJobHandler } = this.deps;
    if (!piiScanJobs || !piiScanJobHandler) {
      return;
    }

    const limit = this.options.maxConcurrentPiiJobs ?? this.options.maxConcurrentJobs;
    const available = limit - this.activePiiCount;
    if (available <= 0) {
      return;
    }

    let claimed: PiiScanJobRecord[];
    try {
      claimed = await piiScanJobs.claimDueJobs(available);
    } catch (error) {
      this.deps.logger.error({ error }, "SchedulerWorker failed to claim PII scan jobs");
      return;
    }

    for (const job of claimed) {
      this.activePiiCount += 1;
      executions.push(
        piiScanJobHandler
          .execute(job)
          .catch((error) => {
            // `PiiScanJobHandler.execute` already records failure state; this
            // catch is a last-resort guard so a raised error doesn't crash the
            // worker tick or leave `activePiiCount` imbalanced.
            this.deps.logger.error(
              { error, jobId: job.jobId },
              "PiiScanJobHandler.execute rejected unexpectedly"
            );
          })
          .finally(() => {
            this.activePiiCount -= 1;
          })
      );
    }
  }

  private async executeJobWithTimeout(job: ScheduledJobRecord): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Scheduled job timed out after ${this.options.jobTimeoutMs}ms`)),
        this.options.jobTimeoutMs
      );
      timer.unref?.();
    });

    try {
      await Promise.race([this.executeJob(job), timeout]);
    } catch (error) {
      // The timeout race rejected. `executeJob` owns the run-record lifecycle
      // (createJobRun → completeJobRun) and is still running in the background;
      // we intentionally do not call completeJobRun here with a fresh UUID
      // because that row was never inserted. activeCount is released by the
      // outer .finally() on executeJobWithTimeout's caller, so releasing a
      // concurrency slot does not require recording an outcome here. Long-
      // pending run records are a diagnostic signal operators can query.
      this.deps.logger.error(
        { error, jobId: job.jobId, timeoutMs: this.options.jobTimeoutMs },
        "Scheduled job exceeded timeout; run_record will stay pending until executeJob settles"
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async executeJob(job: ScheduledJobRecord): Promise<void> {
    const runId = uuidv7();
    const startTime = Date.now();
    let sessionId: string | null = null;
    let status: "completed" | "failed" = "completed";
    let errorMessage: string | null = null;
    let responseText = "";

    try {
      // Why: scheduled jobs replay the full interactive /messages pipeline
      // (session, user+assistant messages, tool context, runtime turn) so
      // audit, tool security, persistence, and approvals behave identically
      // to user-initiated turns. Diverging into a thinner path would mean
      // re-implementing those guarantees.
      const session = await this.deps.sessions.create(
        job.tenantId,
        job.userId,
        `[Scheduled] ${job.jobName}`
      );
      sessionId = session.sessionId;

      await this.deps.settings.createJobRun({
        tenantId: job.tenantId,
        runId,
        jobId: job.jobId,
        userId: job.userId,
        sessionId
      });

      const prompt = typeof job.input.prompt === "string" ? job.input.prompt : JSON.stringify(job.input);

      await this.deps.messages.create({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        role: "user",
        status: "completed",
        content: prompt
      });

      const assistantMessage = await this.deps.messages.create({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        role: "assistant",
        status: "pending",
        content: ""
      });

      const runtimeSession = await this.deps.runtimeManager.createSession({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId
      });

      const runtimePolicyId = await this.deps.runtimeManager.getRuntimePolicyId(job.tenantId);
      const toolContext = await this.deps.toolContexts.create({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        runtimeId: runtimeSession.runtimeId,
        runtimePolicyId,
        messageId: assistantMessage.messageId,
        ttlMs: this.options.jobTimeoutMs
      });

      const stream = this.deps.runtimeManager.runMessage(runtimeSession, {
        prompt,
        runtimePolicyId,
        toolContextId: toolContext.toolContextId,
        assistantMessageId: assistantMessage.messageId
      });

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          responseText += event.delta;
        } else if (event.type === "response.failed") {
          status = "failed";
          errorMessage = event.message;
        }
      }

      await this.deps.messages.updateContent(
        job.tenantId,
        assistantMessage.messageId,
        job.userId,
        status === "completed" ? "completed" : "error",
        responseText
      );
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      this.deps.logger.error({ error, jobId: job.jobId }, "Scheduled job execution failed");
    }

    const durationMs = Date.now() - startTime;
    const summary = responseText.length > 0 ? responseText.slice(0, 500) : null;

    await this.recordJobOutcome(job, { runId, sessionId, status, durationMs, errorMessage, summary });
  }

  private async recordJobOutcome(
    job: ScheduledJobRecord,
    outcome: {
      runId: string;
      sessionId: string | null;
      status: "completed" | "failed";
      durationMs: number;
      errorMessage: string | null;
      summary: string | null;
    }
  ): Promise<void> {
    const { runId, sessionId, status, durationMs, errorMessage, summary } = outcome;

    try {
      await this.deps.settings.completeJobRun({
        tenantId: job.tenantId,
        runId,
        status,
        durationMs,
        inputTokens: 0,
        outputTokens: 0,
        errorMessage,
        summary
      });
    } catch (error) {
      this.deps.logger.error({ error, runId }, "Failed to complete job run record");
    }

    try {
      await this.deps.auditEvents.create({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        type: status === "completed" ? "scheduler.job.run.completed" : "scheduler.job.run.failed",
        payload: {
          jobId: job.jobId,
          runId,
          durationMs,
          ...(errorMessage ? { errorMessage } : {})
        }
      });
    } catch (error) {
      this.deps.logger.error({ error, runId }, "Failed to create audit event for scheduled job");
    }
  }
}
