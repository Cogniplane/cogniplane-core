import { uuidv7 } from "../lib/uuid.js";
import type { TurnStopReason } from "@cogniplane/shared-types";

import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import { startExecutionHeartbeat, stopLostExecution } from "./execution-heartbeat.js";
import { RequestLimitsUnavailableError } from "./redis-request-limits.js";
import type { RequestLimitsInterface } from "./request-limits.js";
import { SessionExecutionError, type SessionExecution, type SessionExecutionStore } from "./session-execution-store.js";
import type { AuditEventStore } from "./audit-event-store.js";
import { computeNextCronRunAt } from "../lib/cron.js";
import type { MessageStore } from "./message-store.js";
import { gateChatPrompt, type ChatPromptGateStores } from "./pii/chat-prompt-pii.js";
import type { PiiScanJobHandler } from "./pii/pii-scan-job-handler.js";
import type { PiiScanJobRecord, PiiScanJobStore } from "./pii/pii-scan-job-store.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import type { ProjectFileStore } from "./project-file-store.js";
import type { RuntimeAdapter, RuntimeReasoningEffort } from "../runtime-contracts.js";
import type { SessionStore, SessionTrashCleanupOptions } from "./session-store.js";
import { redactSecrets } from "./redact-secrets.js";
import {
  GENERIC_TURN_FAILURE,
  TurnTranscript,
  classifyTurnFailure,
  type TurnOutcome,
  type TurnTranscriptMessages
} from "./turn-transcript.js";
import type { ClaimedScheduledJob, ScheduledJobRecord, UserSettingsStore } from "./user-settings-store.js";

/** The text a scheduled job sends to the model. */
export function scheduledJobPrompt(input: ScheduledJobRecord["input"]): string {
  return typeof input.prompt === "string" ? input.prompt : JSON.stringify(input);
}

// 4xx so classifyTurnFailure passes the message through to the job owner.
function jobOwnerError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * A turn limit refused the run: a running-turn cap, the daily quota, or a
 * limit store that is down. That is not the job's fault, so the run does not
 * count toward the auto-disable, and the job runs again at its next time.
 */
class TurnLimitRefusal extends Error {
  readonly statusCode = 400;
}

/**
 * The run error of an interrupted scheduled turn. The owner reads it in the
 * job's run list, so a backend stop says why (TurnStopReason).
 */
export function scheduledInterruptionMessage(reason?: TurnStopReason): string {
  if (reason === "security_change") return "Scheduled job stopped because your account's security settings changed.";
  if (reason === "tool_context_ended") return "Scheduled job stopped because its tool access ended.";
  return "Scheduled job was interrupted.";
}

/** The run error when the owner's account security changed after the claim. */
export const OWNER_SECURITY_CHANGED_RUN_ERROR =
  "The run did not start because your account security changed after the job was saved.";

/** The run error when the backend shut down after the claim, before the turn started. */
export const SCHEDULER_STOPPED_RUN_ERROR = "The run did not start because the scheduler stopped.";

/** The run error when MAX_RUNNING_TURNS_PER_USER or MAX_RUNNING_TURNS_PER_TENANT refused the turn. */
export const RUNNING_TURN_LIMIT_RUN_ERROR =
  "The run did not start because too many turns were running. The job runs again at its next scheduled time.";

/** The run error when the daily turn quota (TURN_QUOTA_PER_*_PER_DAY) refused the turn. */
export const TURN_QUOTA_RUN_ERROR =
  "The run did not start because the daily turn quota is used up. The job runs again at its next scheduled time.";

/** The run error when the request limit store could not count the turn. */
export const TURN_LIMITS_UNAVAILABLE_RUN_ERROR =
  "The run did not start because the turn limits could not be checked. The job runs again at its next scheduled time.";

/**
 * The admission of a scheduled turn, the same as for an interactive turn
 * (routes/messages.ts): a session execution lease, the running-turn caps and
 * the daily turn quota. The `message_turn` rate limit applies to requests only.
 */
export type ScheduledTurnAdmission = {
  executions: Pick<SessionExecutionStore, "acquire" | "heartbeat" | "release" | "stoppedBySecurityChange">;
  limits: Pick<RequestLimitsInterface, "consumeTurnQuota">;
  /** SESSION_EXECUTION_LEASE_MS */
  leaseMs: number;
  /** SESSION_EXECUTION_HEARTBEAT_MS */
  heartbeatMs: number;
  /** MAX_RUNNING_TURNS_PER_USER and MAX_RUNNING_TURNS_PER_TENANT */
  caps: { perUser: number; perTenant: number };
};

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
    | "parkJob"
    | "attachJobRunSession"
    | "completeJobRun"
    | "recordJobRunOutcome"
    | "sweepStaleJobRuns"
    | "pauseJobForSecurityChange"
    | "getOwnerSecurityVersion"
  >;
  sessions: Pick<SessionStore, "create">;
  messages: Pick<MessageStore, "create" | "getOwned"> & TurnTranscriptMessages;
  toolContexts: Pick<ToolExecutionContextStore, "create">;
  runtimeAdapter: SchedulerRuntimeAdapter;
  resolveRuntime: (tenantId: string) => Promise<SchedulerRuntimeResolution>;
  turnAdmission: ScheduledTurnAdmission;
  auditEvents: Pick<AuditEventStore, "create">;
  /**
   * Chat-prompt PII policy for scheduled prompts, the same gate interactive
   * messages use. Absent when PII protection is not configured.
   */
  piiProtection?: ChatPromptGateStores["piiProtection"];
  piiScanRuns?: ChatPromptGateStores["piiScanRuns"];
  /**
   * Optional PII scan subsystem. When both are provided, each worker tick also
   * drains up to `maxConcurrentPiiJobs` queued `pii_scan_jobs` in parallel with
   * scheduled cron jobs. Kept optional so bootstrap paths and tests that don't
   * care about PII don't have to wire it.
   */
  piiScanJobs?: Pick<
    PiiScanJobStore,
    "claimDueJobs" | "sweepStaleClaims" | "listUnfinishedFailures" | "listStalledUploads" | "recoverStalledUpload"
  >;
  piiScanJobHandler?: Pick<PiiScanJobHandler, "execute" | "finishFailedJob">;
  /** Best-effort retention sweep for project files and their stored objects. */
  projectFiles?: Pick<ProjectFileStore, "cleanupExpired">;
  projectFileStorage?: Pick<ArtifactStorage, "delete">;
  sessionTrash?: Pick<SessionStore, "cleanupExpired">;
  /** Retention of the sessions that scheduled runs create. Also needs `sessionStorage`. */
  scheduledSessions?: Pick<SessionStore, "cleanupExpiredScheduled">;
  sessionStorage?: Pick<ArtifactStorage, "delete">;
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
    info(payload: unknown, message: string): void;
  };
};

export type SchedulerRuntimeAdapter = Pick<
  RuntimeAdapter,
  "id" | "createSession" | "runMessageAGUI" | "abortSession" | "purgeSessionData" | "destroySandbox"
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
  /**
   * Days after its last activity that a scheduled session is deleted
   * (SCHEDULED_SESSION_RETENTION_DAYS). Without it, scheduled sessions stay.
   */
  scheduledSessionRetentionDays?: number;
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
  /** The lease of the turn. Set at admission; the job keeps it until its cleanup ends. */
  execution: SessionExecution | null;
  stopHeartbeat: (() => void) | null;
  /** Stops the heartbeat and releases the lease. Runs once. */
  releaseLease: (() => Promise<void>) | null;
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
// Failed PII scan jobs whose scan run each tick closes. Later ticks take the rest.
const UNFINISHED_PII_FAILURE_BATCH = 50;
// Stalled uploads that each tick closes. Later ticks take the rest.
const STALLED_UPLOAD_BATCH = 50;

export class SchedulerWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private activeCount = 0;
  private activePiiCount = 0;
  private projectCleanupInFlight = false;
  private sessionCleanupInFlight = false;
  private scheduledSessionCleanupInFlight = false;
  // Set by stop(): no new job or PII scan is claimed after it.
  private stopping = false;
  // Set by refuseNewTurns(): a claimed job still preparing fails instead of
  // starting a turn on a runtime that is closing.
  private turnsRefused = false;
  // Every tick, job, PII scan and background cleanup still running. drain()
  // waits for them, so shutdown does not close the database pools under a
  // job's outcome write. A job is tracked apart from its tick, because the
  // tick or the job's timeout wrapper can settle before the job does.
  private readonly inFlight = new Set<Promise<unknown>>();

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
    this.stopping = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Call before the runtimes close at shutdown. */
  refuseNewTurns(): void {
    this.stopping = true;
    this.turnsRefused = true;
  }

  /**
   * Waits up to `budgetMs` for the ticks, jobs and cleanups in flight. Returns
   * true when none is left. Call it after stop().
   */
  async drain(budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (this.inFlight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); })
      ]);
      clearTimeout(timer);
    }
    return true;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work), () => this.inFlight.delete(work));
    return work;
  }

  tick(): Promise<void> {
    return this.track(this.runTick());
  }

  private async runTick(): Promise<void> {
    if (this.stopping) return;
    const executions: Promise<void>[] = [];

    void this.track(this.cleanupExpiredProjectFiles());
    void this.track(this.cleanupExpiredSessions());
    void this.track(this.cleanupExpiredScheduledSessions());

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
        if (this.stopping || this.activeCount >= this.options.maxConcurrentJobs) {
          break;
        }
        this.activeCount += 1;
        let claimed: ClaimedScheduledJob | null = null;
        try {
          // The claim also writes the pending run with this id.
          claimed = await this.deps.settings.claimJob(job.tenantId, job.jobId, nextRunAt, uuidv7());
        } finally {
          if (!claimed) {
            this.activeCount -= 1;
          }
        }
        if (!claimed) {
          // The claim also refuses a job whose owner had a security change
          // since the job was saved. Pause such a job, so it leaves the due
          // query. After a claim that another worker won, this changes nothing.
          await this.pauseForSecurityChange(job);
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

  // Both session retention jobs purge through the runtime adapter.
  private sessionPurgeHandlers(): SessionTrashCleanupOptions {
    return {
      purgeRuntime: (input) => this.deps.runtimeAdapter.purgeSessionData(input),
      // The adapter logs a failed kill. This catches only an unexpected throw: the row is gone, so nothing tries again.
      destroySandbox: async (input) => {
        try {
          await this.deps.runtimeAdapter.destroySandbox(input);
        } catch (error) {
          this.deps.logger.error({ error, sessionId: input.sessionId, sandboxId: input.sandboxId },
            "Failed to kill the sandbox of a purged session; it runs until the provider expires it");
        }
      },
    };
  }

  private async cleanupExpiredSessions(): Promise<void> {
    if (!this.deps.sessionTrash || !this.deps.sessionStorage || this.sessionCleanupInFlight) return;
    this.sessionCleanupInFlight = true;
    try {
      const result = await this.deps.sessionTrash.cleanupExpired(this.deps.sessionStorage, this.sessionPurgeHandlers());
      if (result.deletedSessions || result.deletedObjects || result.purgedRuntimes) {
        this.deps.logger.info(result, "Expired session Trash cleaned up");
      }
    } catch (error) {
      this.deps.logger.error({ error }, "Expired session Trash cleanup failed; will retry");
    } finally {
      this.sessionCleanupInFlight = false;
    }
  }

  private async cleanupExpiredScheduledSessions(): Promise<void> {
    const retentionDays = this.options.scheduledSessionRetentionDays;
    if (!this.deps.scheduledSessions || !this.deps.sessionStorage || !retentionDays) return;
    if (this.scheduledSessionCleanupInFlight) return;
    this.scheduledSessionCleanupInFlight = true;
    try {
      const result = await this.deps.scheduledSessions.cleanupExpiredScheduled(this.deps.sessionStorage, {
        ...this.sessionPurgeHandlers(),
        retentionDays,
      });
      if (result.deletedSessions || result.deletedObjects || result.purgedRuntimes) {
        this.deps.logger.info(result, "Expired scheduled sessions cleaned up");
      }
    } catch (error) {
      this.deps.logger.error({ error }, "Expired scheduled session cleanup failed; will retry");
    } finally {
      this.scheduledSessionCleanupInFlight = false;
    }
  }

  private async cleanupExpiredProjectFiles(): Promise<void> {
    if (!this.deps.projectFiles || !this.deps.projectFileStorage) {
      return;
    }
    if (this.projectCleanupInFlight) {
      return;
    }
    this.projectCleanupInFlight = true;

    try {
      const result = await this.deps.projectFiles.cleanupExpired(
        this.deps.projectFileStorage,
      );
      if (result.deletedFiles || result.deletedObjects) {
        this.deps.logger.info(
          result,
          "Expired project files cleaned up",
        );
      }
    } catch (error) {
      this.deps.logger.error(
        { error },
        "Expired project file cleanup failed; will retry",
      );
    } finally {
      this.projectCleanupInFlight = false;
    }
  }

  /**
   * Pause a job whose owner had a security change since the job was saved,
   * and write an audit event. Best-effort: after a failure the job stays
   * enabled, the claim still refuses it, and the next tick tries again.
   */
  private async pauseForSecurityChange(job: ScheduledJobRecord): Promise<void> {
    let paused: boolean;
    try {
      paused = await this.deps.settings.pauseJobForSecurityChange(job.tenantId, job.jobId);
    } catch (error) {
      this.deps.logger.error(
        { error, jobId: job.jobId },
        "Failed to pause scheduled job after a security change of its owner"
      );
      return;
    }
    if (!paused) return;

    this.deps.logger.warn(
      { jobId: job.jobId, tenantId: job.tenantId, userId: job.userId },
      "Scheduled job paused: its owner's account security changed"
    );
    try {
      await this.deps.auditEvents.create({
        tenantId: job.tenantId,
        sessionId: null,
        userId: job.userId,
        type: "scheduler.job.disabled",
        payload: { jobId: job.jobId, reason: "security_change", disabled: true }
      });
    } catch (auditError) {
      this.deps.logger.error(
        { error: auditError, jobId: job.jobId },
        "Failed to create audit event for a job paused after a security change"
      );
    }
  }

  /**
   * A job whose cron expression can't be parsed will never produce a future
   * run. Disable it (preferred) or, if no disable capability is wired, park it
   * with next_run_at = NULL so it goes dormant. Parking is not a claim, so it
   * writes no run. Either way an audit event is written so the
   * disable/dormancy is traceable.
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
        await this.deps.settings.parkJob(job.tenantId, job.jobId);
      } catch (parkError) {
        this.deps.logger.error(
          { error: parkError, jobId: job.jobId },
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
   * lifetime as failed. The claim writes the run, and only the `executeJob`
   * of that claim completes it, so a process crash/restart after the claim
   * strands its row forever without this. The cutoff is strictly longer than
   * the watchdog's worst case (timeout + abort-settle grace) plus a buffer, so
   * live runs are never swept. Best-effort: a sweep failure must not break the tick, and the
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

  // A failed job must not leave its upload or message pending forever.
  private async finishFailedPiiScanJobs(
    piiScanJobs: Pick<PiiScanJobStore, "listUnfinishedFailures">,
    handler: Pick<PiiScanJobHandler, "finishFailedJob">
  ): Promise<void> {
    let jobs: PiiScanJobRecord[];
    try {
      jobs = await piiScanJobs.listUnfinishedFailures(UNFINISHED_PII_FAILURE_BATCH);
    } catch (error) {
      this.deps.logger.error({ error }, "Failed to list failed PII scan jobs with open scan runs");
      return;
    }
    for (const job of jobs) {
      try {
        await handler.finishFailedJob(job);
      } catch (error) {
        this.deps.logger.error({ error, jobId: job.jobId }, "Failed to close the scan run of a failed PII scan job");
      }
    }
  }

  /**
   * An upload stays `pending` when the process stops, or a write fails,
   * between its row and its scan state. No job finds such an upload, so close
   * it here: a recorded decision gets a new job (claimed below in this tick),
   * any other upload fails. Same cutoff as the stale-claim sweep, which is
   * longer than a synchronous scan can run (config.ts).
   */
  private async recoverStalledUploads(
    piiScanJobs: Pick<PiiScanJobStore, "listStalledUploads" | "recoverStalledUpload">,
    staleAfterMs: number
  ): Promise<void> {
    let stalled;
    try {
      stalled = await piiScanJobs.listStalledUploads(staleAfterMs, STALLED_UPLOAD_BATCH);
    } catch (error) {
      this.deps.logger.error({ error }, "Failed to list stalled uploads");
      return;
    }
    for (const upload of stalled) {
      try {
        const outcome = await piiScanJobs.recoverStalledUpload(upload.tenantId, upload.artifactId, staleAfterMs);
        if (outcome !== "skipped") {
          this.deps.logger.warn({ ...upload, outcome }, "Recovered an upload left pending without a scan job");
        }
      } catch (error) {
        this.deps.logger.error({ error, ...upload }, "Failed to recover a stalled upload");
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
    await this.recoverStalledUploads(piiScanJobs, staleAfterMs);
    await this.finishFailedPiiScanJobs(piiScanJobs, piiScanJobHandler);

    const limit = this.options.maxConcurrentPiiJobs ?? this.options.maxConcurrentJobs;
    const available = limit - this.activePiiCount;
    if (this.stopping || available <= 0) {
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
        this.track(piiScanJobHandler.execute(job))
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

  private async executeJobWithTimeout(job: ClaimedScheduledJob): Promise<void> {
    // The claim wrote the pending run, and `executeJob` completes it. On
    // timeout we abort the runtime session. That ends the AG-UI turn and
    // unblocks the `for await` loop, so the same promise settles with
    // status="failed" and records the outcome. We therefore never need to
    // invent a second completeJobRun here.
    const turn: ScheduledTurnHandle = {
      sessionId: null, adapter: null, timedOut: false,
      execution: null, stopHeartbeat: null, releaseLease: null
    };
    // Tracked on its own: after the abort grace this wrapper returns and frees
    // the slot, but the job can still be writing its outcome.
    const execution = this.track(this.executeJob(job, turn));

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

        // Aborting ends the AG-UI turn. `executeJob` then records a failed outcome.
        // The grace starts before the abort and bounds it too: the abort waits
        // for the runtime disposal (MCP close, sandbox kill), which can hang.
        // After the grace we return and the slot is free.
        const graceMs = this.options.abortSettleGraceMs ?? ABORT_SETTLE_GRACE_MS;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        const settleGrace = new Promise<"grace">((resolve) => {
          graceTimer = setTimeout(() => resolve("grace"), graceMs);
          graceTimer.unref?.();
        });

        // A runtime session exists only after admission, so no lease means
        // nothing to abort. The abort names the execution of this job, so it
        // cannot stop a newer turn of the session. It can outlive the grace, so
        // drain() tracks it.
        if (turn.sessionId && turn.adapter && turn.execution) {
          const { sessionId, adapter, execution: admitted } = turn;
          void this.track(adapter.abortSession({
            tenantId: job.tenantId, sessionId, userId: job.userId, executionId: admitted.executionId
          }).catch((error: unknown) => {
            this.deps.logger.error({ error, jobId: job.jobId, sessionId }, "Failed to abort timed-out scheduled job runtime");
          }));
        }

        try {
          const settled = await Promise.race([
            execution.then(() => "settled" as const),
            settleGrace
          ]);
          if (settled === "grace") {
            // The job is still running, so it keeps its lease: a release now
            // would let a new turn start while the old work can still write to
            // the thread. Stop renewing the lease instead. It ends at its
            // expiry, and then the runtime refuses each dispatch of the old
            // turn and the session is free. An admission that ends after this
            // point finds `timedOut` and starts no heartbeat
            // (admitScheduledTurn).
            turn.stopHeartbeat?.();
            this.deps.logger.error(
              { jobId: job.jobId, sessionId: turn.sessionId, graceMs },
              "Timed-out scheduled job did not settle after abort; releasing slot, its lease ends at expiry"
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

  private async executeJob(job: ClaimedScheduledJob, turn: ScheduledTurnHandle): Promise<void> {
    const runId = job.runId;
    const startTime = Date.now();
    let sessionId: string | null = null;
    // Created with the assistant row; it classifies the turn and writes the
    // final transcript exactly as the interactive writer does.
    let transcript: TurnTranscript | null = null;
    let failure: TurnOutcome | undefined;
    // False only for a PII provider outage: it is not the job's fault, and
    // counting it would disable every job during a long outage.
    let countsTowardDisable = true;
    // A watchdog timeout wins over the stream's own terminal event, because
    // the abort race can let a stray event look like success. The transcript
    // reads it until finalization ends, so the row and the run agree. A
    // timeout during cleanup after that does not change the saved outcome.
    const timeoutFailure = (): TurnOutcome | undefined =>
      turn.timedOut
        ? { status: "error", message: `Scheduled job timed out after ${this.options.jobTimeoutMs}ms` }
        : undefined;
    // The watchdog aborts only a session that exists. If it fired before that,
    // stop here so the job does not start a turn or take a reservation.
    const stopIfTimedOut = () => {
      if (turn.timedOut) throw new Error("Scheduled job timed out before its turn started");
      // The runtimes close at shutdown; a job still preparing must not start a turn.
      if (this.turnsRefused) throw jobOwnerError(SCHEDULER_STOPPED_RUN_ERROR);
    };
    // The claim compared the owner's security version, but the account can
    // change while the run prepares (for example during the PII check). Check
    // again before the runtime loads the owner's tools and credentials, and
    // before the turn starts. On a change, refuse the run and pause the job.
    const admitTurn = async () => {
      const current = await this.deps.settings.getOwnerSecurityVersion(job.tenantId, job.userId);
      if (current !== job.ownerSecurityVersion) {
        // The job is paused; the run is not the job's fault.
        countsTowardDisable = false;
        await this.pauseForSecurityChange(job);
        throw jobOwnerError(OWNER_SECURITY_CHANGED_RUN_ERROR);
      }
      stopIfTimedOut();
    };

    try {
      // Why: scheduled jobs replay the full interactive /messages pipeline
      // (session, user+assistant messages, tool context, runtime turn) so
      // audit, tool security, persistence, and approvals behave identically
      // to user-initiated turns. Diverging into a thinner path would mean
      // re-implementing those guarantees.
      // Shutdown can start between the claim and this point.
      stopIfTimedOut();
      const session = await this.deps.sessions.create(
        job.tenantId,
        job.userId,
        `[Scheduled] ${job.jobName}`,
        { purpose: "scheduled" }
      );
      sessionId = session.sessionId;
      // Expose the session id so the timeout watchdog can abort this runtime.
      turn.sessionId = sessionId;

      // The claim wrote the run without a session. No row means that the job
      // was deleted, so the turn does not start.
      const attached = await this.deps.settings.attachJobRunSession({ tenantId: job.tenantId, runId, sessionId });
      if (!attached) throw new Error("Scheduled job run record is missing");
      // Session creation can outlive the job timeout.
      stopIfTimedOut();

      // Before the message rows, so a failure leaves no dangling pending assistant.
      const resolution = await this.deps.resolveRuntime(job.tenantId);
      if (resolution.kind === "error") {
        // 400 (statusCode) so classifyTurnFailure passes this through to
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

      // The lease, before the PII check and the quota: one turn per session on
      // all replicas, and the running-turn caps count this turn.
      stopIfTimedOut();
      const execution = await this.admitScheduledTurn(job, sessionId, runtime, turn, stopIfTimedOut);

      // Apply the current policy at every run: it can change after the job was
      // saved. Nothing is saved or sent to the model before this check.
      const pii = await gateChatPrompt(
        {
          piiProtection: this.deps.piiProtection,
          piiScanRuns: this.deps.piiScanRuns,
          auditEvents: this.deps.auditEvents,
          logger: this.deps.logger
        },
        { tenantId: job.tenantId, sessionId, userId: job.userId, rawText: scheduledJobPrompt(job.input) }
      );
      if (pii.kind === "unavailable") {
        // A permanent error fails every run, so it still counts.
        countsTowardDisable = pii.permanent;
        throw jobOwnerError(
          pii.permanent
            ? `The scheduled prompt could not be checked for sensitive data: ${pii.error.message}`
            : "PII protection was unavailable, so the prompt was not sent. The job runs again at its next scheduled time."
        );
      }
      if (pii.kind === "block") {
        // Same record as an interactive block: the raw prompt is not saved.
        await this.deps.messages.create({
          tenantId: job.tenantId,
          sessionId,
          userId: job.userId,
          role: "system",
          status: "completed",
          content: "Message blocked by organization policy.",
          detail: {
            pii: {
              status: "blocked",
              modeApplied: "block",
              ...(pii.policyRevision !== undefined ? { policyRevision: pii.policyRevision } : {}),
              blockReason: pii.blockReason,
              ...(pii.scanRunId ? { scanRunId: pii.scanRunId } : {})
            }
          }
        });
        throw jobOwnerError(`The scheduled prompt was blocked by organization policy (${pii.blockReason}).`);
      }
      const prompt = pii.runtimePrompt;

      // After the PII check, as for an interactive turn: a blocked prompt does
      // not spend the quota.
      await this.consumeTurnQuota(job);

      await this.deps.messages.create({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        role: "user",
        status: "completed",
        content: pii.persistedText,
        ...(pii.userDetail ? { detail: pii.userDetail } : {})
      });

      const assistantMessage = await this.deps.messages.create({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        role: "assistant",
        status: "pending",
        content: ""
      });
      const scheduledTurn = new TurnTranscript({
        messages: this.deps.messages,
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        messageId: assistantMessage.messageId,
        logger: this.deps.logger,
        lateFailure: timeoutFailure
      });
      transcript = scheduledTurn;

      await admitTurn();
      const runtimeSession = await runtime.createSession({
        tenantId: job.tenantId,
        sessionId,
        userId: job.userId,
        execution
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
        metadata: { runtimePolicy: runtimeSession.runtimePolicy,
          ...(runtimeSession.mcpServerSources ? { mcpServerSources: runtimeSession.mcpServerSources } : {}),
          ...(runtimeSession.integrationAccounts ? { integrationAccounts: runtimeSession.integrationAccounts } : {}),
          executionId: execution.executionId,
          turnContext: "scheduled" },
        // The version that the claim and admitTurn compared. After a security
        // change of the owner, the gateway refuses the turn's tool calls, also
        // when this replica's runtime is not stopped (security-change.ts).
        ownerSecurityVersion: job.ownerSecurityVersion,
        // Outlive the job watchdog by a margin — a context TTL equal to the
        // timeout would let a tool call near the deadline race context expiry
        // and fail with -32000 instead of running to the watchdog.
        ttlMs: this.options.jobTimeoutMs + 60 * 1000
      });

      // Scheduled turns intentionally use the organization default: they are
      // unattended, so nobody can answer a native approval prompt. The runtime
      // rejects gated tool calls at once for `turnContext: "scheduled"`. Policy
      // Center still receives the scheduled turn context through the tool
      // execution metadata above.
      await admitTurn();
      const stream = runtime.runMessageAGUI(runtimeSession, {
        prompt,
        toolContextId: toolContext.toolContextId,
        turnContext: "scheduled",
        assistantMessageId: assistantMessage.messageId,
        model: resolution.modelId ?? undefined,
        effort: resolution.effort
      });

      // No mid-turn progress writes: nobody watches a scheduled turn live, so
      // the transcript is written once at the end.
      for await (const event of stream) {
        scheduledTurn.apply(event);
      }
    } catch (error) {
      if (error instanceof TurnLimitRefusal) countsTowardDisable = false;
      // Classify before persisting. The message is written to the assistant
      // row and scheduled_job_runs, put into the scheduler.job.run.failed audit
      // payload, and returned to the job owner by
      // GET /me/scheduled-jobs/:jobId/runs — so a raw exception puts Postgres
      // connection strings, E2B sandbox ids and internal hostnames in front of
      // a user. The full error still reaches the logger line below, which is
      // where an operator should read it.
      failure = classifyTurnFailure(error, false);
      this.deps.logger.error({ error, jobId: job.jobId }, "Scheduled job execution failed");
    }

    let outcome: TurnOutcome = timeoutFailure() ?? failure ?? { status: "error", message: GENERIC_TURN_FAILURE };
    let responseText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    // The lease stays until the runtime is gone, so no other turn of the
    // session starts before then.
    try {
      if (transcript) {
        // Read usage first, so a timeout during the read still fails the turn.
        ({ inputTokens, outputTokens } = await this.readTurnUsage(job, transcript));
        const finalized = await transcript.finalize(failure);
        outcome = finalized.outcome;
        responseText = finalized.text;
      }

      await this.reclaimScheduledSession(job, sessionId, turn);
    } finally {
      await turn.releaseLease?.();
    }

    const durationMs = Date.now() - startTime;
    // The job owner reads the summary from the run ledger. Redact the full
    // text before the cut, so a secret across the 500-character limit still
    // matches. `responseText` stays raw for the transcript offsets.
    const summary = responseText.length > 0 ? redactSecrets(responseText).slice(0, 500) : null;

    await this.recordJobOutcome(job, {
      runId,
      sessionId,
      status: outcome.status === "completed" ? "completed" : "failed",
      durationMs,
      errorMessage:
        outcome.status === "error"
          ? outcome.message
          : outcome.status === "interrupted"
            ? scheduledInterruptionMessage(outcome.reason)
            : null,
      summary,
      inputTokens,
      outputTokens,
      countsTowardDisable
    });
  }

  /**
   * Takes the lease of the scheduled turn and starts its heartbeat. The caps
   * are those of interactive turns. When the heartbeat loses the lease (a stop,
   * a security change, an expiry), the runtime turn of this execution stops.
   *
   * `stopIfTimedOut` runs after the lease is taken: a slow admission can end
   * after the watchdog fired, or after it gave up on the job. Then no runtime
   * session uses the lease yet, so it is released at once, and no heartbeat
   * renews it.
   */
  private async admitScheduledTurn(
    job: ClaimedScheduledJob,
    sessionId: string,
    runtime: SchedulerRuntimeAdapter,
    turn: ScheduledTurnHandle,
    stopIfTimedOut: () => void
  ): Promise<SessionExecution> {
    const admission = this.deps.turnAdmission;
    const leaseStartedAt = performance.now();
    let execution: SessionExecution;
    try {
      execution = await admission.executions.acquire(
        { tenantId: job.tenantId, sessionId, userId: job.userId }, admission.leaseMs, admission.caps, "scheduled"
      );
    } catch (error) {
      if (error instanceof SessionExecutionError && error.code === "running_turn_limit") {
        throw new TurnLimitRefusal(RUNNING_TURN_LIMIT_RUN_ERROR, { cause: error });
      }
      throw error;
    }
    turn.execution = execution;
    const admitted = execution;
    let released: Promise<void> | null = null;
    const releaseLease = () => released ??= (async () => {
      turn.stopHeartbeat?.();
      try {
        await admission.executions.release(admitted);
      } catch (error) {
        this.deps.logger.error({ error, jobId: job.jobId, sessionId }, "Failed to release scheduled execution lease");
      }
    })();
    turn.releaseLease = releaseLease;
    try {
      stopIfTimedOut();
    } catch (error) {
      await releaseLease();
      throw error;
    }
    const leaseExpiresAt = performance.now() + Math.max(0, new Date(admitted.expiresAt).getTime() - Date.now());
    turn.stopHeartbeat = startExecutionHeartbeat({
      leaseStartedAt,
      leaseExpiresAt,
      leaseMs: admission.leaseMs,
      intervalMs: admission.heartbeatMs,
      renew: () => admission.executions.heartbeat(admitted, admission.leaseMs),
      onError: (error) => this.deps.logger.warn({ error, jobId: job.jobId, sessionId }, "Scheduled execution heartbeat failed"),
      onLost: async () => {
        this.deps.logger.warn({ jobId: job.jobId, sessionId }, "Scheduled execution lease lost; stopping the turn");
        await stopLostExecution({ execution: admitted, executions: admission.executions, runtime });
      }
    });
    return execution;
  }

  /** Spends one unit of the daily turn quota of the owner and the tenant. */
  private async consumeTurnQuota(job: ClaimedScheduledJob): Promise<void> {
    let exceeded: Awaited<ReturnType<ScheduledTurnAdmission["limits"]["consumeTurnQuota"]>>;
    try {
      exceeded = await this.deps.turnAdmission.limits.consumeTurnQuota({ userId: job.userId, tenantId: job.tenantId });
    } catch (error) {
      if (error instanceof RequestLimitsUnavailableError) {
        throw new TurnLimitRefusal(TURN_LIMITS_UNAVAILABLE_RUN_ERROR, { cause: error });
      }
      throw error;
    }
    if (exceeded) throw new TurnLimitRefusal(TURN_QUOTA_RUN_ERROR);
  }

  /**
   * Recover real token usage. AG-UI events carry no usage. The in-process
   * runtime adapter saves it on the assistant row during the turn, so read the
   * row instead of recording 0. The job-run ledger backs the scheduler's
   * separate usage accounting. Also read after a failed turn, because the
   * provider may have charged for part of it.
   */
  private async readTurnUsage(
    job: ScheduledJobRecord,
    transcript: TurnTranscript
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    try {
      const persisted = await this.deps.messages.getOwned(job.tenantId, transcript.messageId, job.userId);
      if (persisted?.tokenUsage) {
        return {
          inputTokens: persisted.tokenUsage.inputTokens,
          outputTokens: persisted.tokenUsage.outputTokens
        };
      }
    } catch (usageError) {
      this.deps.logger.warn(
        { error: usageError, jobId: job.jobId },
        "Failed to read scheduled-turn token usage; recording 0"
      );
    }
    return { inputTokens: 0, outputTokens: 0 };
  }

  /**
   * Releases the per-run runtime.
   *
   * Each firing creates a new session (see executeJob), and nothing else
   * reclaims its runtime. Without this call, a completed run leaves a warm
   * runtime, and a live E2B sandbox if the job touched files, until
   * RUNTIME_IDLE_TIMEOUT_MS.
   *
   * The worker does not delete the checkpoint thread. Scheduled session
   * retention (`cleanupExpiredScheduledSessions`) deletes it with the session,
   * SCHEDULED_SESSION_RETENTION_DAYS after the last activity. An eager delete
   * here would be a check and then a write with no lock between them: after a
   * Stop or a lease expiry, the owner can start a turn on this session on any
   * replica, and a delete that started before that would remove the new
   * turn's checkpoints. The cost is storage: one thread for each run, kept for
   * the retention window. The `sessions` and `messages` rows stay too:
   * `scheduled_job_runs` references the session, and the owner can read the
   * transcript and continue the chat.
   *
   * Best-effort: reclamation must never change a run's recorded outcome.
   *
   * No lease means no runtime: the runtime session is created only after
   * admission. The abort names the execution of this job, so it cannot stop a
   * newer turn of the session.
   *
   * The abort runs UNCONDITIONALLY, also after a watchdog timeout. "Timed out"
   * does not mean "aborted": the watchdog aborts only when the job had a lease
   * at that time, its abort can throw, and it can hang. abortSession is
   * idempotent (it does nothing for a session or execution that it does not
   * hold), so the second call on the normal timeout path costs a map lookup.
   */
  private async reclaimScheduledSession(
    job: ScheduledJobRecord,
    sessionId: string | null,
    turn: ScheduledTurnHandle
  ): Promise<void> {
    const { adapter, execution } = turn;
    if (!sessionId || !adapter || !execution) return;
    try {
      await adapter.abortSession({
        tenantId: job.tenantId, sessionId, userId: job.userId, executionId: execution.executionId
      });
    } catch (error) {
      // Idle teardown still reclaims the runtime.
      this.deps.logger.warn(
        { error, jobId: job.jobId, sessionId },
        "Failed to release scheduled-run runtime; falling back to idle teardown"
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
      countsTowardDisable: boolean;
    }
  ): Promise<void> {
    const { runId, sessionId, status, durationMs, errorMessage, summary, inputTokens, outputTokens } =
      outcome;

    try {
      const completed = await this.deps.settings.completeJobRun({
        tenantId: job.tenantId,
        runId,
        status,
        durationMs,
        inputTokens,
        outputTokens,
        errorMessage,
        summary
      });
      // The run row goes with its job, so a job deleted during the run has none.
      if (!completed) {
        this.deps.logger.warn({ runId, jobId: job.jobId }, "Scheduled job run record is missing; outcome not saved");
      }
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
    if (status === "completed" || outcome.countsTowardDisable) {
      await this.updatePoisonState(job, status === "completed");
    }
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
