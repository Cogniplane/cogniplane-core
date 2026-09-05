import { EventType } from "@ag-ui/client";
import { uuidv7 } from "../lib/uuid.js";

import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import type { AuditEventStore } from "./audit-event-store.js";
import { computeNextCronRunAt } from "../lib/cron.js";
import type { MessageStore } from "./message-store.js";
import type { PiiScanJobHandler } from "./pii/pii-scan-job-handler.js";
import type { PiiScanJobRecord, PiiScanJobStore } from "./pii/pii-scan-job-store.js";
import type { RuntimeAdapter, RuntimeReasoningEffort } from "../runtime-contracts.js";
import type { SessionStore } from "./session-store.js";
import { clientSafeFailureMessage } from "./sse-writer.js";
import type { ScheduledJobRecord, UserSettingsStore } from "./user-settings-store.js";

/**
 * Per-job runtime resolution, mirroring the interactive /messages path
 * (`resolveRuntimeModel`): validates key presence and picks the default model
 * so a scheduled turn runs exactly as a user-initiated turn would.
 * `kind: "error"` carries the human-readable reason (adapter unavailable,
 * missing API key) — the run is recorded as failed.
 */
export type SchedulerRuntimeResolution =
  | {
      kind: "ok";
      adapter: SchedulerRuntimeAdapter;
      modelId: string | null;
      /** Tenant default-effort override for the resolved model (if any). */
      effort?: RuntimeReasoningEffort;
    }
  | { kind: "error"; message: string };

export type SchedulerWorkerDeps = {
  settings: Pick<
    UserSettingsStore,
    | "listDueJobs"
    | "claimJob"
    | "createJobRun"
    | "completeJobRun"
    | "recordJobRunOutcome"
    | "sweepStaleJobRuns"
  >;
  sessions: Pick<SessionStore, "create">;
  messages: Pick<MessageStore, "create" | "getOwned" | "updateContent">;
  toolContexts: Pick<ToolExecutionContextStore, "create">;
  resolveRuntime: (tenantId: string) => Promise<SchedulerRuntimeResolution>;
  auditEvents: Pick<AuditEventStore, "create">;
  /**
   * Optional PII scan subsystem. When both are provided, each worker tick also
   * drains up to `maxConcurrentPiiJobs` queued `pii_scan_jobs` in parallel with
   * scheduled cron jobs. `buildSchedulerWorker` only threads these in when the
   * PII drain is safe to run (PII_PROVIDER_ENABLED — which guarantees the boot
   * guard asserted a BYPASSRLS pool for the cross-tenant claim); otherwise they
   * are left undefined and the drain no-ops. Kept optional so bootstrap paths
   * and tests that don't care about PII don't have to wire it.
   */
  piiScanJobs?: Pick<PiiScanJobStore, "claimDueJobs" | "sweepStaleClaims">;
  piiScanJobHandler?: Pick<PiiScanJobHandler, "execute">;
  /**
   * Disables a job (sets enabled = FALSE) so it permanently leaves the
   * `listDueJobs` query. Used for poison jobs whose cron is invalid or which
   * have failed repeatedly. Optional only because the SQL backing it
   * (`UserSettingsStore.disableJob`) and its bootstrap wiring live outside this
   * file; when absent the worker degrades to leaving the job dormant
   * (next_run_at = NULL) and still emits the audit trail.
   */
  disableJob?: (input: { tenantId: string; jobId: string }) => Promise<void>;
  logger: {
    error(payload: unknown, message: string): void;
    warn(payload: unknown, message: string): void;
  };
};

export type SchedulerRuntimeAdapter = Pick<
  RuntimeAdapter,
  "id" | "createSession" | "runMessageAGUI" | "abortSession" | "purgeSessionData"
>;

export type SchedulerWorkerOptions = {
  /**
   * When false, the worker still ticks but skips the cron half entirely (no
   * `listDueJobs`, no scheduled-turn execution) — it exists solely to drain the
   * async PII scan queue. This is how the PII async path stays alive when
   * `SCHEDULER_ENABLED=false`. Defaults to true (cron half active) when omitted.
   */
  schedulingEnabled?: boolean;
  maxConcurrentJobs: number;
  jobTimeoutMs: number;
  maxConcurrentPiiJobs?: number;
  /**
   * Auto-disable a job once it has failed this many times in a row (reset on any
   * success). Undefined/0 disables the poison guard. The job's running count
   * lives in `scheduled_jobs.consecutive_failures`.
   */
  maxConsecutiveFailures?: number;
  /** Max time to wait for an aborted, timed-out turn to settle before releasing
   * the slot. Defaults to ABORT_SETTLE_GRACE_MS; overridable for tests. */
  abortSettleGraceMs?: number;
};

/**
 * Shared mutable handle between `executeJobWithTimeout` (the watchdog) and
 * `executeJob` (the worker). The worker publishes its `sessionId` and the
 * resolved runtime adapter so the watchdog can abort the runtime on timeout
 * via the adapter that actually owns the session; the watchdog sets `timedOut`
 * so the worker records a deterministic timeout failure regardless of which
 * terminal event won the abort race.
 */
type ScheduledTurnHandle = {
  sessionId: string | null;
  adapter: SchedulerRuntimeAdapter | null;
  timedOut: boolean;
};

/**
 * After a job times out we abort its runtime and wait for `executeJob` to settle
 * and record a failed outcome. But if there was no session to abort yet, or the
 * runtime ignores the abort, that wait could hang forever — which would leak the
 * `activeCount` slot and eventually wedge the whole worker. Cap the wait: once
 * this grace elapses we release the slot regardless (the abort was already sent;
 * `executeJob`, if still alive, records its outcome whenever it finally settles).
 */
const ABORT_SETTLE_GRACE_MS = 30_000;

/**
 * Safety margin added on top of (job timeout + abort-settle grace) before a
 * pending `scheduled_job_runs` row is considered orphaned by a crash/restart.
 * A healthy run can stay pending for at most timeout + grace; anything older
 * has no live `executeJob` left to complete it.
 */
const STALE_RUN_SWEEP_BUFFER_MS = 60_000;

/** Max orphaned run rows recovered per tick; the rest drain on later ticks. */
const STALE_RUN_SWEEP_BATCH_SIZE = 100;

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

    const schedulingEnabled = this.options.schedulingEnabled ?? true;
    if (schedulingEnabled) {
      // Every tick, not just boot: the query is a no-op (partial-index scan,
      // zero rows) in steady state.
      await this.sweepStaleJobRuns();
    }

    const available = this.options.maxConcurrentJobs - this.activeCount;
    if (schedulingEnabled && available > 0) {
      const dueJobs = await this.deps.settings.listDueJobs(available);

      for (const job of dueJobs) {
        let nextRunAt: string | null;
        try {
          nextRunAt = computeNextCronRunAt(job.cronExpression, job.timeZone);
        } catch (error) {
          // An invalid cron can never produce a future run. Disable the job so
          // it leaves the due-job query for good instead of lingering as an
          // enabled-but-dormant row (next_run_at = NULL) that an operator might
          // mistake for "scheduled". Emit an audit event so the disable is
          // traceable.
          await this.handleInvalidCronJob(job, error);
          continue;
        }

        // Reserve the slot synchronously BEFORE the claim await. tick() can
        // overlap itself (a stalled tick plus the next interval firing), and
        // `available` was computed before any await — two overlapping ticks
        // would otherwise both admit with the same headroom and transiently
        // exceed maxConcurrentJobs. Check-and-increment with no await in
        // between makes over-admission impossible; the reservation is
        // released when the claim loses or throws. Unclaimed due jobs stay
        // due and are picked up by a later tick.
        if (this.activeCount >= this.options.maxConcurrentJobs) {
          break;
        }
        this.activeCount += 1;
        let claimed: ScheduledJobRecord | null = null;
        try {
          claimed = await this.deps.settings.claimJob(job.tenantId, job.jobId, nextRunAt);
        } finally {
          if (!claimed) {
            this.activeCount -= 1;
          }
        }
        if (!claimed) {
          continue;
        }

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

  /**
   * A job whose cron expression can't be parsed will never produce a future
   * run. Disable it (preferred) or, if no disable capability is wired, claim it
   * with next_run_at = NULL so it goes dormant. Either way an audit event is
   * written so the disable/dormancy is traceable.
   */
  private async handleInvalidCronJob(job: ScheduledJobRecord, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.deps.logger.error(
      { error, jobId: job.jobId, cronExpression: job.cronExpression, timeZone: job.timeZone },
      "Scheduled job has invalid cron expression; disabling"
    );

    let disabled = false;
    if (this.deps.disableJob) {
      try {
        await this.deps.disableJob({
          tenantId: job.tenantId,
          jobId: job.jobId
        });
        disabled = true;
      } catch (disableError) {
        this.deps.logger.error(
          { error: disableError, jobId: job.jobId },
          "Failed to disable job with invalid cron expression"
        );
      }
    }

    // Fallback: take the job out of the due query by clearing next_run_at so a
    // per-minute invalid-cron job doesn't re-fire this branch every tick.
    if (!disabled) {
      try {
        await this.deps.settings.claimJob(job.tenantId, job.jobId, null);
      } catch (claimError) {
        this.deps.logger.error(
          { error: claimError, jobId: job.jobId },
          "Failed to park job with invalid cron expression"
        );
      }
    }

    try {
      await this.deps.auditEvents.create({
        tenantId: job.tenantId,
        sessionId: null,
        userId: job.userId,
        type: "scheduler.job.disabled",
        payload: {
          jobId: job.jobId,
          reason: "invalid_cron",
          cronExpression: job.cronExpression,
          timeZone: job.timeZone,
          errorMessage: reason,
          disabled
        }
      });
    } catch (auditError) {
      this.deps.logger.error(
        { error: auditError, jobId: job.jobId },
        "Failed to create audit event for invalid-cron job"
      );
    }
  }

  /**
   * Mark `scheduled_job_runs` rows stuck in `pending` past any legitimate
   * lifetime as failed. A run is only ever completed by the `executeJob` that
   * created it, so a process crash/restart strands its rows forever without
   * this. The cutoff is strictly longer than the watchdog's worst case
   * (timeout + abort-settle grace) plus a buffer, so live runs are never
   * swept. Best-effort: a sweep failure must not break the tick, and the
   * poison counter is NOT touched — a crash is not the job's fault.
   */
  private async sweepStaleJobRuns(): Promise<void> {
    const cutoffMs =
      this.options.jobTimeoutMs +
      (this.options.abortSettleGraceMs ?? ABORT_SETTLE_GRACE_MS) +
      STALE_RUN_SWEEP_BUFFER_MS;

    let orphaned;
    try {
      orphaned = await this.deps.settings.sweepStaleJobRuns(cutoffMs, STALE_RUN_SWEEP_BATCH_SIZE);
    } catch (error) {
      this.deps.logger.error({ error }, "Failed to sweep orphaned scheduled job runs");
      return;
    }

    for (const run of orphaned) {
      this.deps.logger.warn(
        { runId: run.runId, jobId: run.jobId, sessionId: run.sessionId },
        "Recovered scheduled job run orphaned by a crash/restart"
      );
      try {
        await this.deps.auditEvents.create({
          tenantId: run.tenantId,
          sessionId: run.sessionId,
          userId: run.userId,
          type: "scheduler.job.run.failed",
          payload: {
            jobId: run.jobId,
            runId: run.runId,
            reason: "orphaned_on_sweep"
          }
        });
      } catch (error) {
        this.deps.logger.error(
          { error, runId: run.runId },
          "Failed to create audit event for orphaned job run"
        );
      }
    }
  }

  private async drainPiiScanJobs(executions: Promise<void>[]): Promise<void> {
    const { piiScanJobs, piiScanJobHandler } = this.deps;
    if (!piiScanJobs || !piiScanJobHandler) {
      return;
    }

    // Recover jobs stranded in `claimed` by a crashed worker before claiming new
    // ones — symmetric with sweepStaleJobRuns for scheduled runs. Same cutoff as
    // that sweep (job timeout + settle grace + buffer) so a job that is merely
    // still running is never yanked out from under its handler.
    const staleAfterMs =
      this.options.jobTimeoutMs +
      (this.options.abortSettleGraceMs ?? ABORT_SETTLE_GRACE_MS) +
      STALE_RUN_SWEEP_BUFFER_MS;
    try {
      const swept = await piiScanJobs.sweepStaleClaims(staleAfterMs);
      if (swept > 0) {
        this.deps.logger.warn({ swept }, "Recovered PII scan jobs orphaned by a crash/restart");
      }
    } catch (error) {
      this.deps.logger.error({ error }, "Failed to sweep stale PII scan job claims");
    }

    const limit = this.options.maxConcurrentPiiJobs ?? this.options.maxConcurrentJobs;
    const available = limit - this.activePiiCount;
    if (available <= 0) {
      return;
    }

    // Reserve the full headroom synchronously BEFORE the claim await (same
    // overlapping-tick hazard as the cron half: two ticks computing the same
    // `available` would over-admit). The DB claim is atomic, so jobs never
    // double-run — only the concurrency cap was at stake. Unused reservations
    // are released once the claim returns.
    this.activePiiCount += available;

    let claimed: PiiScanJobRecord[];
    try {
      claimed = await piiScanJobs.claimDueJobs(available);
    } catch (error) {
      this.activePiiCount -= available;
      this.deps.logger.error({ error }, "SchedulerWorker failed to claim PII scan jobs");
      return;
    }

    this.activePiiCount -= available - claimed.length;

    for (const job of claimed) {
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
    // `executeJob` owns the run-record lifecycle. On timeout we abort the
    // runtime session. That ends the AG-UI turn and unblocks the `for await` loop,
    // so the same promise settles with status="failed" and records the outcome.
    // We therefore never need to invent a second completeJobRun here.
    const turn: ScheduledTurnHandle = { sessionId: null, adapter: null, timedOut: false };
    const execution = this.executeJob(job, turn);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        turn.timedOut = true;
        resolve();
      }, this.options.jobTimeoutMs);
      timer.unref?.();
    });

    try {
      const winner = await Promise.race([execution.then(() => "done" as const), timeout.then(() => "timeout" as const)]);

      if (winner === "timeout") {
        this.deps.logger.error(
          { jobId: job.jobId, sessionId: turn.sessionId, timeoutMs: this.options.jobTimeoutMs },
          "Scheduled job exceeded timeout; aborting runtime session"
        );

        // No adapter yet means the runtime was never resolved/started for this
        // job, so there is nothing to abort — the slot-release grace below
        // still bounds the wait.
        if (turn.sessionId && turn.adapter) {
          try {
            await turn.adapter.abortSession({
              tenantId: job.tenantId,
              sessionId: turn.sessionId,
              userId: job.userId
            });
          } catch (error) {
            this.deps.logger.error(
              { error, jobId: job.jobId, sessionId: turn.sessionId },
              "Failed to abort timed-out scheduled job runtime"
            );
          }
        }

        // Aborting ends the AG-UI turn. `executeJob` then records a failed outcome.
        // Bound the wait so a turn that never settles (no session was
        // created yet, or the runtime ignored the abort) can't pin this slot
        // forever — after the grace we return and let the slot free.
        const graceMs = this.options.abortSettleGraceMs ?? ABORT_SETTLE_GRACE_MS;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        const settleGrace = new Promise<"grace">((resolve) => {
          graceTimer = setTimeout(() => resolve("grace"), graceMs);
          graceTimer.unref?.();
        });
        try {
          const settled = await Promise.race([
            execution.then(() => "settled" as const),
            settleGrace
          ]);
          if (settled === "grace") {
            this.deps.logger.error(
              { jobId: job.jobId, sessionId: turn.sessionId, graceMs },
              "Timed-out scheduled job did not settle after abort; releasing slot"
            );
          }
        } finally {
          if (graceTimer) clearTimeout(graceTimer);
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async executeJob(job: ScheduledJobRecord, turn: ScheduledTurnHandle): Promise<void> {
    const runId = uuidv7();
    const startTime = Date.now();
    let sessionId: string | null = null;
    let status: "completed" | "failed" = "completed";
    let errorMessage: string | null = null;
    let responseText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      // Why: scheduled jobs replay the full interactive /messages pipeline
      // (session, user+assistant messages, tool context, runtime turn) so
      // audit, tool security, persistence, and approvals behave identically
      // to user-initiated turns. Diverging into a thinner path would mean
      // re-implementing those guarantees.
      const session = await this.deps.sessions.create(
        job.tenantId,
        job.userId,
        `[Scheduled] ${job.jobName}`,
        { purpose: "scheduled" }
      );
      sessionId = session.sessionId;
      // Expose the session id so the timeout watchdog can abort this runtime.
      turn.sessionId = sessionId;

      await this.deps.settings.createJobRun({
        tenantId: job.tenantId,
        runId,
        jobId: job.jobId,
        userId: job.userId,
        sessionId
      });

      // Ordering: after createJobRun so a failure lands on a real run row,
      // before the message rows so it leaves no dangling pending assistant.
      const resolution = await this.deps.resolveRuntime(job.tenantId);
      if (resolution.kind === "error") {
        // 400 (statusCode) so clientSafeFailureMessage passes this through to
        // the job owner. The resolver's message is written for a user
        // ("configure a model provider key"), unlike the SDK and driver errors
        // that reach the same catch and are deliberately collapsed there.
        throw Object.assign(
          new Error(`Runtime provider resolution failed: ${resolution.message}`),
          { statusCode: 400 }
        );
      }
      const runtime = resolution.adapter;
      // Expose the adapter so the timeout watchdog aborts via the owning runtime.
      turn.adapter = runtime;

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

      const runtimeSession = await runtime.createSession({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId
      });

      const toolContext = await this.deps.toolContexts.create({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        runtimeId: runtimeSession.runtimeId,
        runtimePolicyId: runtimeSession.runtimePolicy.id,
        messageId: assistantMessage.messageId,
        // Mark this as an unattended turn so a Policy Center rule can gate
        // scheduled actions more strictly. Keep the same runtimePolicy snapshot
        // as interactive turns so the MCP gateway can enforce enabled tools and
        // servers for scheduled tool calls.
        metadata: { runtimePolicy: runtimeSession.runtimePolicy, turnContext: "scheduled" },
        // Outlive the job watchdog by a margin — a context TTL equal to the
        // timeout would let a tool call near the deadline race context expiry
        // and fail with -32000 instead of running to the watchdog.
        ttlMs: this.options.jobTimeoutMs + 60 * 1000
      });

      const stream = runtime.runMessageAGUI(runtimeSession, {
        prompt,
        toolContextId: toolContext.toolContextId,
        turnContext: "scheduled",
        assistantMessageId: assistantMessage.messageId,
        model: resolution.modelId ?? undefined,
        effort: resolution.effort
      });

      for await (const event of stream) {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
          responseText += event.delta;
        } else if (event.type === EventType.RUN_ERROR) {
          status = "failed";
          errorMessage =
            typeof event.message === "string" ? event.message : "The assistant run failed.";
        }
      }

      await this.deps.messages.updateContent(
        job.tenantId,
        assistantMessage.messageId,
        job.userId,
        status === "completed" ? "completed" : "error",
        responseText
      );

      // Recover real token usage. AG-UI events carry no usage. The in-process
      // runtime adapter persists it onto the assistant message row mid-turn —
      // so re-read the row instead of recording 0 (the old behavior lied to the
      // job-run ledger that backs the scheduler's separate usage accounting).
      try {
        const persisted = await this.deps.messages.getOwned(
          job.tenantId,
          assistantMessage.messageId,
          job.userId
        );
        if (persisted?.tokenUsage) {
          inputTokens = persisted.tokenUsage.inputTokens;
          outputTokens = persisted.tokenUsage.outputTokens;
        }
      } catch (usageError) {
        this.deps.logger.warn(
          { error: usageError, jobId: job.jobId },
          "Failed to read scheduled-turn token usage; recording 0"
        );
      }
    } catch (error) {
      status = "failed";
      // Classify before persisting. `errorMessage` is written to
      // scheduled_job_runs, put into the scheduler.job.run.failed audit
      // payload, and returned to the job owner by
      // GET /me/scheduled-jobs/:jobId/runs — so a raw exception puts Postgres
      // connection strings, E2B sandbox ids and internal hostnames in front of
      // a user. The interactive path already classifies through the same
      // helper; this path did not. The full error still reaches the logger
      // line below, which is where an operator should read it.
      errorMessage = clientSafeFailureMessage(error);
      this.deps.logger.error({ error, jobId: job.jobId }, "Scheduled job execution failed");
    }

    // If the watchdog tripped, force a failed outcome with a timeout message
    // even if the abort race let a stray terminal event mark the turn complete.
    if (turn.timedOut) {
      status = "failed";
      errorMessage = `Scheduled job timed out after ${this.options.jobTimeoutMs}ms`;
    }

    await this.reclaimScheduledSession(job, sessionId, turn.adapter);

    const durationMs = Date.now() - startTime;
    const summary = responseText.length > 0 ? responseText.slice(0, 500) : null;

    await this.recordJobOutcome(job, {
      runId,
      sessionId,
      status,
      durationMs,
      errorMessage,
      summary,
      inputTokens,
      outputTokens
    });
  }

  /**
   * Release the per-run runtime and its checkpointer thread.
   *
   * Each firing creates a fresh session (see executeJob), and nothing else ever
   * reclaims it: `abortSession` was previously only reached on the timeout path,
   * so a completed run left a warm runtime — and a live E2B sandbox, if the job
   * touched files — parked until RUNTIME_IDLE_TIMEOUT_MS, and left a LangGraph
   * thread in the `deep_agents` schema forever. A scheduled session is never
   * resumed (a new one is created next tick), so that thread is pure garbage;
   * `purgeSessionData` is normally only called from the session DELETE route.
   *
   * The `sessions` / `messages` rows are deliberately KEPT: `scheduled_job_runs`
   * references the session id and the run-detail UI reads the transcript. Their
   * one-row-per-run growth is inherent to the feature and needs a retention
   * policy, not a teardown here.
   *
   * Best-effort throughout — reclamation must never change a run's recorded
   * outcome.
   *
   * The abort runs UNCONDITIONALLY, including after a watchdog timeout. It is
   * tempting to skip it when `turn.timedOut` is set, since executeJobWithTimeout
   * aborts on that path — but "timed out" does not imply "aborted": the watchdog
   * only aborts `if (turn.sessionId && turn.adapter)`, and `turn.adapter` is
   * assigned by the racing executeJob, so a timeout that fires before runtime
   * resolution aborts nothing. Its abortSession can also throw. Either way the
   * skip would drop the ONLY abort and leave the runtime (and its E2B sandbox)
   * alive, then purge the thread underneath a graph still writing checkpoints.
   * abortSession is idempotent — it no-ops on a session id it no longer holds —
   * so the redundant call on the happy timeout path costs a map lookup.
   */
  private async reclaimScheduledSession(
    job: ScheduledJobRecord,
    sessionId: string | null,
    adapter: SchedulerRuntimeAdapter | null
  ): Promise<void> {
    if (!sessionId || !adapter) return;
    const scope = { tenantId: job.tenantId, sessionId, userId: job.userId };

    // Ordered before the purge: tearing the thread down while the graph can
    // still write would race checkpoint writes against the delete.
    try {
      await adapter.abortSession(scope);
    } catch (error) {
      // The abort is a PRECONDITION of the purge, not a best-effort step beside
      // it. If it failed we cannot assume the graph has stopped, so deleting its
      // thread now would corrupt a run that is still writing. Bail out and leave
      // the thread: idle teardown still reclaims the runtime, and an orphaned
      // checkpointer thread is a bounded storage leak — strictly the better of
      // the two failures.
      this.deps.logger.warn(
        { error, jobId: job.jobId, sessionId },
        "Failed to release scheduled-run runtime; skipping thread purge and falling back to idle teardown"
      );
      return;
    }

    try {
      await adapter.purgeSessionData(scope);
    } catch (error) {
      this.deps.logger.warn(
        { error, jobId: job.jobId, sessionId },
        "Failed to purge scheduled-run checkpointer thread"
      );
    }
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
      inputTokens: number;
      outputTokens: number;
    }
  ): Promise<void> {
    const { runId, sessionId, status, durationMs, errorMessage, summary, inputTokens, outputTokens } =
      outcome;

    try {
      await this.deps.settings.completeJobRun({
        tenantId: job.tenantId,
        runId,
        status,
        durationMs,
        inputTokens,
        outputTokens,
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

    // Poison-job guard: update the consecutive-failure counter (reset on
    // success) and auto-disable a job that has failed too many times in a row,
    // so a perpetually-failing per-minute cron can't re-fire every tick forever.
    await this.updatePoisonState(job, status === "completed");
  }

  /**
   * Increment/reset the job's consecutive-failure counter and disable it once it
   * crosses `maxConsecutiveFailures`. Best-effort — a failure here only loses the
   * poison guard for one tick, so it must never throw into the run loop.
   */
  private async updatePoisonState(job: ScheduledJobRecord, succeeded: boolean): Promise<void> {
    let failures: number;
    try {
      failures = await this.deps.settings.recordJobRunOutcome(job.tenantId, job.jobId, succeeded);
    } catch (error) {
      this.deps.logger.error(
        { error, jobId: job.jobId },
        "Failed to update scheduled-job failure counter"
      );
      return;
    }

    const threshold = this.options.maxConsecutiveFailures ?? 0;
    if (succeeded || threshold <= 0 || failures < threshold) {
      return;
    }

    this.deps.logger.error(
      { jobId: job.jobId, failures, threshold },
      "Scheduled job hit the consecutive-failure limit; disabling"
    );

    let disabled = false;
    if (this.deps.disableJob) {
      try {
        await this.deps.disableJob({
          tenantId: job.tenantId,
          jobId: job.jobId
        });
        disabled = true;
      } catch (error) {
        this.deps.logger.error(
          { error, jobId: job.jobId },
          "Failed to disable repeatedly-failing scheduled job"
        );
      }
    }

    try {
      await this.deps.auditEvents.create({
        tenantId: job.tenantId,
        sessionId: null,
        userId: job.userId,
        type: "scheduler.job.disabled",
        payload: {
          jobId: job.jobId,
          reason: "repeated_failures",
          consecutiveFailures: failures,
          threshold,
          disabled
        }
      });
    } catch (error) {
      this.deps.logger.error(
        { error, jobId: job.jobId },
        "Failed to create audit event for poison-disabled job"
      );
    }
  }
}
