/**
 * Shared types for the Tier 3 LLM judge. Provider implementations and the
 * worker both depend on these.
 *
 * The two-step contract (`submit` + `poll`) collapses to one step in sync mode
 * but stays open for batch mode. A worker calls `submit(input)` and inspects
 * `mode`:
 *   - "sync"  → results are already attached, write them and mark completed
 *   - "batch" → persist `batchId`, status='submitted'; a separate poller
 *               eventually calls `poll(batchId)` and resolves results.
 */

export type SkillJudgeInput = {
  tenantId: string;
  sessionId: string;
  /** Skills the agent had access to during this session. */
  availableSkills: AvailableSkill[];
  /** Ordered turn-by-turn transcript. */
  transcript: TranscriptEntry[];
};

export type AvailableSkill = {
  skillId: string;
  skillName: string;
  description: string | null;
  /** Optional excerpt of the SKILL.md instructions (truncated by caller). */
  instructionsExcerpt?: string | null;
};

export type TranscriptEntry =
  | { kind: "message"; messageId: string; role: "user" | "assistant"; content: string }
  | {
      kind: "tool_call";
      toolResultId: string;
      messageId: string;
      toolName: string | null;
      server: string | null;
      input: string;
      output: string;
      status: "in_progress" | "completed" | "failed" | "declined";
    };

export type JudgmentEvidence = {
  messageId?: string | null;
  toolResultId?: string | null;
  quote?: string;
  reason?: string;
};

export type SkillJudgmentResult = {
  skillId: string;
  invoked: boolean;
  /** 0..1 — the model's self-reported confidence. */
  confidence: number;
  evidence: JudgmentEvidence[];
};

export type SkillJudgeOutput = {
  /** One entry per skill the judge inspected. Order is not significant. */
  skills: SkillJudgmentResult[];
};

/**
 * Each input is keyed by `(tenantId, sessionId)` already; the provider may
 * use them to compose a `custom_id` per batch entry. Sync providers ignore
 * the bundling and just iterate.
 */
export type SubmissionResult =
  | {
      mode: "sync";
      /** One result per submitted input, keyed by sessionId. */
      results: Map<string, SyncResult>;
    }
  | {
      mode: "batch";
      batchId: string;
      /**
       * Sessions included in this batch. The poller persists this list so
       * `markCompleted`/`markFailed` can be applied per session when the
       * batch resolves.
       */
      sessionIds: string[];
    };

export type SyncResult =
  | { status: "succeeded"; output: SkillJudgeOutput; rawRequestId?: string | null }
  | { status: "failed"; error: string };

export type PollResult =
  | { status: "in_progress" }
  | {
      status: "completed";
      /** One entry per session that was in the batch, keyed by sessionId. */
      results: Map<string, SyncResult>;
    }
  | { status: "failed"; error: string };

export interface SkillJudgeProvider {
  /** Provider identifier — matches `tenant_settings.skill_judge_provider`. */
  readonly providerId: string;
  /** "sync" or "batch" — matches `tenant_settings.skill_judge_mode`. */
  readonly mode: "sync" | "batch";
  /**
   * Submit one or more sessions for judgment. Sync providers return all
   * results inline; batch providers create a single underlying batch and
   * return its handle plus the list of sessions it covers.
   */
  submit(inputs: SkillJudgeInput[]): Promise<SubmissionResult>;
  /**
   * Poll a batch submission. Sync providers may omit this — they should
   * never be called this way in practice because sync submissions never
   * make it into the in-flight queue.
   */
  poll?(batchId: string, sessionIds: string[]): Promise<PollResult>;
}
