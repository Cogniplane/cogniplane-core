import type { FastifyBaseLogger } from "fastify";

import type { ActivationTracker } from "../../activation-tracker.js";
import type { DynamicConfigService } from "../../dynamic-config-service.js";
import type { MessageStore } from "../../message-store.js";
import type {
  EligibleSession,
  InflightBatch,
  JudgmentKind,
  SessionJudgmentStore
} from "../../session-judgment-store.js";
import type {
  SkillJudgeInput,
  SkillJudgeOutput,
  SkillJudgeProvider,
  SubmissionResult,
  SyncResult,
  TranscriptEntry
} from "./skill-judge-types.js";

/**
 * Worker that drives the Tier 3 LLM judge.
 *
 * Each tick has two passes:
 *
 *   1. **Submit pass** — pulls eligible sessions, groups them by
 *      `(provider, model, mode)`, claims each row in DB, and calls
 *      `provider.submit(inputs[])` once per group. Sync providers return
 *      results inline and the worker persists them in the same tick.
 *      Batch providers return a `batchId` plus the list of sessions it
 *      covers, and the worker stamps every row with that batchId.
 *
 *   2. **Poll pass** — walks `judgments.listInflightBatches()` and calls
 *      `provider.poll(batchId, sessionIds)` for each group. Completed
 *      batches dispatch back to the same `persistJudgment` path the sync
 *      flow uses; failed batches mark all their sessions failed.
 *
 * Both passes share `persistJudgment` / `failJudgment` helpers, so adding
 * a new provider just means implementing `SkillJudgeProvider`.
 */

const SKILL_INVOCATION: JudgmentKind = "skill_invocation";

export type SessionJudgeProviderFactory = (input: {
  tenantId: string;
  provider: string;
  model: string;
  mode: "sync" | "batch";
}) => Promise<SkillJudgeProvider | null> | SkillJudgeProvider | null;

export type SessionJudgeWorkerDeps = {
  judgments: SessionJudgmentStore;
  messages: MessageStore;
  dynamicConfig: DynamicConfigService;
  activations: ActivationTracker;
  providerFactory: SessionJudgeProviderFactory;
  logger: FastifyBaseLogger;
};

export type SessionJudgeWorkerOptions = {
  /** How long a session must be inactive before it's eligible. */
  inactiveBeforeMs: number;
  /** Max sessions to claim per tick. Keeps a single tick from blocking too long. */
  maxSessionsPerTick: number;
  /** Max inflight batches inspected per poll pass. */
  maxBatchesPerPoll?: number;
  /**
   * `running` sync rows older than this are demoted to `failed` at the start
   * of every tick. Set to 0 to disable the reaper (not recommended outside
   * of tests).
   */
  runningTimeoutMs: number;
};

/**
 * Progress events emitted by `tick()` for live observability — the admin
 * "execute now" endpoint streams these as SSE so an operator can see what
 * the worker is actually doing. Logging is best-effort: subscribers must
 * not throw, since their errors would mask real failures in the worker.
 */
export type JudgeProgressEvent =
  | { kind: "tick_started"; tenantId: string | null }
  | { kind: "eligible_found"; count: number; tenantId: string | null }
  | { kind: "submit_skipped_inflight_batches"; pendingBatchCount: number }
  | { kind: "session_claimed"; tenantId: string; sessionId: string; provider: string; model: string; mode: "sync" | "batch" }
  | { kind: "session_skipped_no_skills"; tenantId: string; sessionId: string }
  | { kind: "session_completed"; tenantId: string; sessionId: string; skillsJudged: number; invokedCount: number }
  | { kind: "session_failed"; tenantId: string; sessionId: string; error: string }
  | { kind: "batch_submitted"; provider: string; model: string; batchId: string; sessionCount: number }
  | { kind: "tick_completed"; durationMs: number }
  | { kind: "reaped_running_rows"; count: number };

export type ProgressListener = (event: JudgeProgressEvent) => void;

type ClaimedSession = {
  eligible: EligibleSession;
  input: SkillJudgeInput;
};

export class SessionJudgeWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  /**
   * Set for the duration of a single `tick()` run. Helpers reach it via
   * `this.emitProgress`. Safe because `isRunning` serializes ticks.
   */
  private currentEmitter: ((event: JudgeProgressEvent) => void) | null = null;

  constructor(
    private readonly deps: SessionJudgeWorkerDeps,
    private readonly options: SessionJudgeWorkerOptions
  ) {}

  private emitProgress(event: JudgeProgressEvent): void {
    if (!this.currentEmitter) return;
    try {
      this.currentEmitter(event);
    } catch {
      // Subscriber bug must never crash the worker.
    }
  }

  start(pollIntervalMs: number): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick();
    }, pollIntervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Single tick — submit pass first, then poll pass. Exposed so tests and
   * admin tooling can drive the worker deterministically. Safe to call
   * concurrently: the second call returns immediately if a tick is already
   * in flight.
   *
   * Pass `tenantId` to scope the submit pass to a single tenant (used by
   * the admin "execute now" button — we only want to surface that tenant's
   * eligible sessions, not everybody else's). The poll pass remains global
   * because batch results that finish during a manual tick should still be
   * harvested. Pass `onProgress` for live event streaming.
   */
  async tick(options: { tenantId?: string; onProgress?: ProgressListener } = {}): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.currentEmitter = options.onProgress ?? null;
    const startedAt = Date.now();
    this.emitProgress({ kind: "tick_started", tenantId: options.tenantId ?? null });
    try {
      await this.reapPass();
      await this.submitPass(options.tenantId);
      await this.pollPass();
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "session-judge-worker: tick failed"
      );
    } finally {
      this.emitProgress({ kind: "tick_completed", durationMs: Date.now() - startedAt });
      this.currentEmitter = null;
      this.isRunning = false;
    }
  }

  // ─── Reap pass ─────────────────────────────────────────────────────────────

  /**
   * Demotes `running` sync rows that have been running too long to `failed`.
   * These are orphans from a crash mid-tick. Without this sweep they sit
   * forever and block their sessions from being re-judged. Runs first so
   * the freshly-failed rows free their sessions for the same tick's submit
   * pass — the next tick won't have to wait.
   */
  private async reapPass(): Promise<void> {
    if (this.options.runningTimeoutMs <= 0) return;
    let count: number;
    try {
      count = await this.deps.judgments.reapStuckRunningRows(this.options.runningTimeoutMs);
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "session-judge-worker: reap pass failed; continuing with submit/poll"
      );
      return;
    }
    if (count > 0) {
      this.emitProgress({ kind: "reaped_running_rows", count });
      this.deps.logger.warn(
        { count, olderThanMs: this.options.runningTimeoutMs },
        "session-judge-worker: reaped stuck 'running' rows"
      );
    }
  }

  // ─── Submit pass ───────────────────────────────────────────────────────────

  private async submitPass(tenantId: string | undefined): Promise<void> {
    // Inflight-batch guard: when batch mode is in use, batches can take up
    // to 24 hours to resolve. Re-submitting before the prior batch completes
    // would burn budget and risk double-judging the same session if the
    // schema guard ever drifts. The per-session PK already prevents
    // duplicates, but skipping the submit pass entirely is the cheaper,
    // clearer policy.
    const inflight = await this.deps.judgments.listInflight(
      this.options.maxSessionsPerTick * 4
    );
    const pendingBatchCount = inflight.filter(
      (row) => row.mode === "batch" && row.batchId &&
        (!tenantId || row.tenantId === tenantId)
    ).length;
    if (pendingBatchCount > 0) {
      this.emitProgress({ kind: "submit_skipped_inflight_batches", pendingBatchCount });
      return;
    }

    const eligible = await this.deps.judgments.listSessionsToJudge(
      SKILL_INVOCATION,
      this.options.inactiveBeforeMs,
      this.options.maxSessionsPerTick,
      tenantId
    );
    this.emitProgress({
      kind: "eligible_found",
      count: eligible.length,
      tenantId: tenantId ?? null
    });
    if (eligible.length === 0) return;

    // Group by (provider, model, mode) so each provider invocation covers
    // sessions it can pack into a single underlying request/batch.
    const groups = groupEligibleSessions(eligible);
    for (const group of groups) {
      await this.submitGroup(group);
    }
  }

  private async submitGroup(group: EligibleGroup): Promise<void> {
    const provider = await this.resolveGroupProvider(group);
    if (!provider) return;

    const claimed = await this.claimAndPrepareGroup(group);
    if (claimed.length === 0) return;

    const submission = await this.submitClaimed(provider, claimed);
    if (!submission) return;

    if (submission.mode === "sync") {
      await this.dispatchSyncResults(provider, claimed, submission.results);
    } else {
      await this.stampBatchSubmission(group, claimed, submission);
    }
  }

  /**
   * Look up the provider for `group`. On factory failure or "no provider
   * available", claim and fail every session in the group so the rows don't
   * loop forever, and return null so `submitGroup` short-circuits.
   */
  private async resolveGroupProvider(group: EligibleGroup): Promise<SkillJudgeProvider | null> {
    try {
      const provider = await this.deps.providerFactory({
        tenantId: group.tenantId,
        provider: group.provider,
        model: group.model,
        mode: group.mode
      });
      if (provider) return provider;
      const err = new Error(`No judge provider available for ${group.provider}.`);
      for (const session of group.sessions) {
        await this.claimAndFail(session, err);
      }
      return null;
    } catch (err) {
      // Factory failed — every session in this group fails the same way.
      for (const session of group.sessions) {
        await this.claimAndFail(session, err);
      }
      return null;
    }
  }

  /**
   * Claim each session in DB, build its judge input, and skip sessions with
   * no available skills (those terminate early as `completed` with reason
   * `no_skills_available`). Returns the surviving claimed sessions ready
   * for submission.
   */
  private async claimAndPrepareGroup(group: EligibleGroup): Promise<ClaimedSession[]> {
    const claimed: ClaimedSession[] = [];
    for (const session of group.sessions) {
      const claim = await this.deps.judgments.claim({
        tenantId: session.tenantId,
        sessionId: session.sessionId,
        judgmentKind: SKILL_INVOCATION,
        provider: session.provider,
        model: session.model,
        mode: session.mode
      });
      if (!claim) continue; // Lost the race — another worker owns it now.
      this.emitProgress({
        kind: "session_claimed",
        tenantId: session.tenantId,
        sessionId: session.sessionId,
        provider: session.provider,
        model: session.model,
        mode: session.mode
      });

      let input: SkillJudgeInput;
      try {
        input = await this.buildInput(session);
      } catch (err) {
        await this.failJudgment(session, err);
        continue;
      }

      if (input.availableSkills.length === 0) {
        await this.deps.judgments.markCompleted({
          tenantId: session.tenantId,
          sessionId: session.sessionId,
          judgmentKind: SKILL_INVOCATION,
          metadata: { source: "llm_judge", reason: "no_skills_available" }
        });
        this.emitProgress({
          kind: "session_skipped_no_skills",
          tenantId: session.tenantId,
          sessionId: session.sessionId
        });
        continue;
      }

      claimed.push({ eligible: session, input });
    }
    return claimed;
  }

  /**
   * Wrap `provider.submit` with whole-group failure handling. The submit
   * contract is "either return per-session results or throw" — a throw here
   * covers e.g. network down or auth misconfigured. Returns null on failure
   * so `submitGroup` short-circuits.
   */
  private async submitClaimed(
    provider: SkillJudgeProvider,
    claimed: ClaimedSession[]
  ): Promise<SubmissionResult | null> {
    try {
      return await provider.submit(claimed.map((c) => c.input));
    } catch (err) {
      for (const c of claimed) {
        await this.failJudgment(c.eligible, err);
      }
      return null;
    }
  }

  /** Persist sync provider results, failing any session the provider skipped. */
  private async dispatchSyncResults(
    provider: SkillJudgeProvider,
    claimed: ClaimedSession[],
    results: Map<string, SyncResult>
  ): Promise<void> {
    for (const c of claimed) {
      const result = results.get(c.eligible.sessionId);
      if (!result) {
        await this.failJudgment(
          c.eligible,
          new Error("Provider did not return a result for this session.")
        );
        continue;
      }
      await this.applySyncResult(c.eligible, provider, result);
    }
  }

  /**
   * Stamp every claimed row with the batch id so the poll pass can resolve
   * them once the batch finishes. Logs a warning if the provider's declared
   * session count diverges from the worker's claimed count — a divergence is
   * benign (the worker stamps its own rows; the provider's bookkeeping
   * lives on its side) but worth surfacing.
   */
  private async stampBatchSubmission(
    group: EligibleGroup,
    claimed: ClaimedSession[],
    submission: Extract<SubmissionResult, { mode: "batch" }>
  ): Promise<void> {
    for (const c of claimed) {
      await this.deps.judgments.markSubmitted({
        tenantId: c.eligible.tenantId,
        sessionId: c.eligible.sessionId,
        judgmentKind: SKILL_INVOCATION,
        batchId: submission.batchId
      });
    }
    this.emitProgress({
      kind: "batch_submitted",
      provider: group.provider,
      model: group.model,
      batchId: submission.batchId,
      sessionCount: claimed.length
    });

    if (submission.sessionIds.length !== claimed.length) {
      this.deps.logger.warn(
        {
          batchId: submission.batchId,
          declared: submission.sessionIds.length,
          claimed: claimed.length
        },
        "session-judge-worker: batch session count mismatch"
      );
    }
  }

  // ─── Poll pass ─────────────────────────────────────────────────────────────

  private async pollPass(): Promise<void> {
    const limit = this.options.maxBatchesPerPoll ?? 50;
    const batches = await this.deps.judgments.listInflightBatches(limit);
    for (const batch of batches) {
      await this.pollOne(batch);
    }
  }

  private emitJudgmentResult(
    eligible: EligibleSession,
    output: SkillJudgeOutput
  ): void {
    const invokedCount = output.skills.filter((s) => s.invoked).length;
    this.emitProgress({
      kind: "session_completed",
      tenantId: eligible.tenantId,
      sessionId: eligible.sessionId,
      skillsJudged: output.skills.length,
      invokedCount
    });
  }

  private async pollOne(batch: InflightBatch): Promise<void> {
    const tenantId = this.extractBatchTenant(batch);
    if (!tenantId) return;

    const provider = await this.resolveBatchProvider(tenantId, batch);
    if (!provider) return;

    let pollResult;
    try {
      pollResult = await provider.poll!(
        batch.batchId,
        batch.sessions.map((s) => s.sessionId)
      );
    } catch (err) {
      this.deps.logger.warn(
        { batchId: batch.batchId, err: err instanceof Error ? err.message : String(err) },
        "session-judge-worker: poll failed; will retry next tick"
      );
      return;
    }

    if (pollResult.status === "in_progress") return;

    if (pollResult.status === "failed") {
      for (const session of batch.sessions) {
        await this.deps.judgments.markFailed({
          tenantId: session.tenantId,
          sessionId: session.sessionId,
          judgmentKind: SKILL_INVOCATION,
          error: `batch ${batch.batchId} failed: ${pollResult.error}`.slice(0, 1000)
        });
      }
      return;
    }

    await this.applyBatchResults(provider, batch, pollResult.results);
  }

  /**
   * Take the tenant from the first session in `batch`. After the
   * (tenantId, provider, model, mode) grouping change every session in a
   * batch shares a tenant — verify and return null on either no sessions
   * (nothing to resolve) or a multi-tenant batch (refuse to poll, since
   * we'd silently use the wrong tenant's API key).
   */
  private extractBatchTenant(batch: InflightBatch): string | null {
    const tenantId = batch.sessions[0]?.tenantId;
    if (!tenantId) return null;
    if (batch.sessions.some((s) => s.tenantId !== tenantId)) {
      this.deps.logger.warn(
        { batchId: batch.batchId },
        "session-judge-worker: batch contains sessions from multiple tenants — refusing to poll."
      );
      return null;
    }
    return tenantId;
  }

  /**
   * Look up the poller for a batch. On factory failure, fail every session
   * in the batch so the rows don't loop forever. If the provider has no
   * `poll`, leave the rows for an admin to clear manually.
   */
  private async resolveBatchProvider(
    tenantId: string,
    batch: InflightBatch
  ): Promise<SkillJudgeProvider | null> {
    let provider: SkillJudgeProvider | null;
    try {
      provider = await this.deps.providerFactory({
        tenantId,
        provider: batch.provider,
        model: batch.model,
        mode: "batch"
      });
    } catch (err) {
      for (const session of batch.sessions) {
        await this.failJudgment(
          {
            tenantId: session.tenantId,
            sessionId: session.sessionId,
            userId: "",
            provider: batch.provider,
            model: batch.model,
            mode: "batch"
          },
          err
        );
      }
      return null;
    }
    if (!provider || !provider.poll) return null;
    return provider;
  }

  /**
   * Walk every session in a completed batch, find its per-session result,
   * persist via the same `applySyncResult` path the inline sync flow uses.
   * Sessions the provider skipped get marked failed.
   */
  private async applyBatchResults(
    provider: SkillJudgeProvider,
    batch: InflightBatch,
    results: Map<string, SyncResult>
  ): Promise<void> {
    for (const session of batch.sessions) {
      const result = results.get(session.sessionId);
      if (!result) {
        await this.deps.judgments.markFailed({
          tenantId: session.tenantId,
          sessionId: session.sessionId,
          judgmentKind: SKILL_INVOCATION,
          error: `batch ${batch.batchId} completed without a result for this session`
        });
        continue;
      }
      const eligible: EligibleSession = {
        tenantId: session.tenantId,
        sessionId: session.sessionId,
        userId: "",
        provider: batch.provider,
        model: batch.model,
        mode: "batch"
      };
      await this.applySyncResult(eligible, provider, result);
    }
  }

  // ─── Shared helpers ────────────────────────────────────────────────────────

  private async applySyncResult(
    eligible: EligibleSession,
    provider: SkillJudgeProvider,
    result: SyncResult
  ): Promise<void> {
    if (result.status === "failed") {
      await this.failJudgment(eligible, new Error(result.error));
      return;
    }
    await this.persistJudgment(eligible, provider, result.output, result.rawRequestId);
    this.emitJudgmentResult(eligible, result.output);
  }

  private async claimAndFail(eligible: EligibleSession, err: unknown): Promise<void> {
    const claim = await this.deps.judgments.claim({
      tenantId: eligible.tenantId,
      sessionId: eligible.sessionId,
      judgmentKind: SKILL_INVOCATION,
      provider: eligible.provider,
      model: eligible.model,
      mode: eligible.mode
    });
    if (!claim) return;
    await this.failJudgment(eligible, err);
  }

  private async buildInput(eligible: EligibleSession): Promise<SkillJudgeInput> {
    const bundle = await this.deps.dynamicConfig.compileRuntimeConfig(
      eligible.tenantId,
      true,
      eligible.sessionId
    );
    const availableSkills = bundle.skills.map((skill) => ({
      skillId: skill.id,
      skillName: skill.name,
      description: skill.description ?? null,
      instructionsExcerpt: skill.instructions ?? null
    }));

    const messages = await this.deps.messages.listBySession(
      eligible.tenantId,
      eligible.sessionId,
      eligible.userId
    );

    const transcript: TranscriptEntry[] = [];
    for (const message of messages) {
      if (message.role === "user" || message.role === "assistant") {
        transcript.push({
          kind: "message",
          messageId: message.messageId,
          role: message.role,
          content: message.content
        });
      }
      for (const tool of message.toolResults) {
        transcript.push({
          kind: "tool_call",
          toolResultId: tool.toolResultId,
          messageId: message.messageId,
          toolName: tool.toolName,
          server: tool.server,
          input: tool.input,
          output: tool.output,
          status:
            tool.status === "completed" ||
            tool.status === "failed" ||
            tool.status === "declined"
              ? tool.status
              : "in_progress"
        });
      }
    }

    return {
      tenantId: eligible.tenantId,
      sessionId: eligible.sessionId,
      availableSkills,
      transcript
    };
  }

  private async persistJudgment(
    eligible: EligibleSession,
    provider: SkillJudgeProvider,
    output: SkillJudgeOutput,
    rawRequestId: string | null | undefined
  ): Promise<void> {
    const events = output.skills.map((result) => ({
      resourceType: "skill" as const,
      resourceId: result.skillId,
      eventType: result.invoked ? ("invoked" as const) : ("materialized" as const),
      metadata: {
        source: "llm_judge",
        provider: provider.providerId,
        model: eligible.model,
        invoked: result.invoked,
        confidence: result.confidence,
        evidence: result.evidence
      }
    }));

    if (events.length > 0) {
      await this.deps.activations.recordEvents(
        {
          tenantId: eligible.tenantId,
          sessionId: eligible.sessionId,
          messageId: null
        },
        events
      );
    }

    await this.deps.judgments.markCompleted({
      tenantId: eligible.tenantId,
      sessionId: eligible.sessionId,
      judgmentKind: SKILL_INVOCATION,
      metadata: {
        source: "llm_judge",
        provider: provider.providerId,
        model: eligible.model,
        rawRequestId: rawRequestId ?? null,
        skillsJudged: output.skills.length
      }
    });
  }

  private async failJudgment(eligible: EligibleSession, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.deps.logger.warn(
      {
        tenantId: eligible.tenantId,
        sessionId: eligible.sessionId,
        provider: eligible.provider,
        err: message
      },
      "session-judge-worker: judgment failed"
    );
    await this.deps.judgments.markFailed({
      tenantId: eligible.tenantId,
      sessionId: eligible.sessionId,
      judgmentKind: SKILL_INVOCATION,
      error: message.slice(0, 1000)
    });
    this.emitProgress({
      kind: "session_failed",
      tenantId: eligible.tenantId,
      sessionId: eligible.sessionId,
      error: message.slice(0, 500)
    });
  }
}

type EligibleGroup = {
  tenantId: string;
  provider: string;
  model: string;
  mode: "sync" | "batch";
  sessions: EligibleSession[];
};

/**
 * Group by `(tenantId, provider, model, mode)`. Tenant has to be part of
 * the key because each tenant supplies its own Anthropic/OpenAI key — packing
 * sessions from different tenants into one provider call would charge the
 * wrong account (and on Anthropic Batch, leak transcripts across billing
 * boundaries). Same provider/model from two tenants → two separate calls.
 */
function groupEligibleSessions(sessions: EligibleSession[]): EligibleGroup[] {
  const groups = new Map<string, EligibleGroup>();
  for (const session of sessions) {
    const key = `${session.tenantId}|${session.provider}|${session.model}|${session.mode}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        tenantId: session.tenantId,
        provider: session.provider,
        model: session.model,
        mode: session.mode,
        sessions: []
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return Array.from(groups.values());
}
