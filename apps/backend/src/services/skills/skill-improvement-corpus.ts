import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { uuidv7 } from "../../lib/uuid.js";

import { type Pool, withTenantScope } from "../../lib/db.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactRecord, ArtifactStore } from "../artifacts/artifact-store.js";
import type { MessageRecord, ToolResultRecord } from "../message-store.js";
import type { PiiProtectionService, PiiSubject } from "../pii/pii-protection-service.js";
import { redactSecrets } from "../redact-secrets.js";

const TOOL_OUTPUT_EXCERPT_BYTES = 800;
const TOOL_INPUT_EXCERPT_BYTES = 400;
const ABSOLUTE_MAX_SESSIONS = 200;
const DEFAULT_SESSIONS = 50;
/**
 * Whole-corpus byte ceiling. Default ~512 KiB keeps the artifact small
 * enough for the improver agent to read in one shot while still covering
 * dozens of sessions. The orchestrator stops appending sessions once this
 * is exceeded — sessions are never split mid-stream.
 */
const DEFAULT_CORPUS_BYTE_BUDGET = 512 * 1024;

export type CorpusSessionInput = {
  sessionId: string;
  sessionName: string | null;
  occurredAt: string;
  messages: MessageRecord[];
};

export type CorpusFormatterInput = {
  skill: {
    skillId: string;
    skillName: string;
    description: string | null;
    instructions: string;
  };
  tenantId: string;
  generatedAt: string;
  sessionLimit: number;
  sessions: CorpusSessionInput[];
  /**
   * Optional ceiling. When set, the formatter stops appending whole sessions
   * once `markdown.length` would exceed this value and records the count of
   * sessions it skipped in `excludedSessionCount`.
   */
  byteBudget?: number;
};

export type CorpusFormatterOutput = {
  markdown: string;
  includedSessionCount: number;
  excludedSessionCount: number;
  truncatedToolResultCount: number;
};

// ── Pure formatter ──────────────────────────────────────────────────────────

/**
 * Builds the markdown corpus the improver agent reads. Pure function so it
 * can be unit-tested with fake rows.
 *
 * Redaction: every user-visible string (message content, tool input, tool
 * output) flows through `redactSecrets()` before reaching the artifact.
 * Tool outputs are also clipped to `TOOL_OUTPUT_EXCERPT_BYTES`; tool inputs
 * to `TOOL_INPUT_EXCERPT_BYTES`. Truncations are counted so the agent can
 * see the elision.
 *
 * Budget: when `byteBudget` is set, the formatter stops emitting whole
 * sessions once the running markdown would exceed it. Sessions are never
 * split mid-stream — the agent should see complete transcripts or none.
 */
export function formatCorpus(input: CorpusFormatterInput): CorpusFormatterOutput {
  const lines: string[] = [];
  let truncatedToolResultCount = 0;
  let includedSessionCount = 0;
  let excludedSessionCount = 0;

  lines.push(`# Skill improvement corpus — ${input.skill.skillName}`);
  lines.push("");
  lines.push(`- **Skill id:** \`${input.skill.skillId}\``);
  lines.push(`- **Tenant:** \`${input.tenantId}\``);
  lines.push(`- **Generated:** ${input.generatedAt}`);
  lines.push(`- **Session limit:** ${input.sessionLimit}`);
  lines.push(`- **Sessions considered:** ${input.sessions.length}`);
  lines.push("");
  lines.push("## Current SKILL.md");
  lines.push("");
  lines.push(input.skill.description ?? "_(no description)_");
  lines.push("");
  lines.push("```markdown");
  lines.push(input.skill.instructions.trim() || "_(no instructions)_");
  lines.push("```");
  lines.push("");
  lines.push("## Sessions where this skill was invoked");
  lines.push("");

  if (input.sessions.length === 0) {
    lines.push(
      "_No prior sessions found for this skill yet. Ask the admin what they want to focus on._"
    );
    lines.push("");
    return {
      markdown: lines.join("\n"),
      includedSessionCount: 0,
      excludedSessionCount: 0,
      truncatedToolResultCount: 0
    };
  }

  let runningBytes = lines.join("\n").length;
  const budget = input.byteBudget;

  for (const session of input.sessions) {
    const { sessionLines, sessionTruncatedToolResults } = renderSession(session);
    const sessionBytes = sessionLines.reduce((sum, line) => sum + line.length + 1, 0);

    if (budget !== undefined && includedSessionCount > 0 && runningBytes + sessionBytes > budget) {
      excludedSessionCount += 1;
      continue;
    }

    lines.push(...sessionLines);
    runningBytes += sessionBytes;
    truncatedToolResultCount += sessionTruncatedToolResults;
    includedSessionCount += 1;
  }

  if (excludedSessionCount > 0) {
    lines.push("");
    lines.push(
      `_Note: ${excludedSessionCount} additional session(s) were excluded after exceeding the corpus byte budget._`
    );
  }

  return {
    markdown: lines.join("\n"),
    includedSessionCount,
    excludedSessionCount,
    truncatedToolResultCount
  };
}

function renderSession(session: CorpusSessionInput): {
  sessionLines: string[];
  sessionTruncatedToolResults: number;
} {
  const sessionLines: string[] = [];
  let sessionTruncatedToolResults = 0;

  sessionLines.push(`### Session \`${session.sessionId}\``);
  if (session.sessionName) sessionLines.push(`- **Name:** ${session.sessionName}`);
  sessionLines.push(`- **Last activity:** ${session.occurredAt}`);
  sessionLines.push("");

  if (session.messages.length === 0) {
    sessionLines.push("_(no messages in this session)_");
    sessionLines.push("");
    return { sessionLines, sessionTruncatedToolResults };
  }

  for (const message of session.messages) {
    sessionLines.push(`#### ${message.role} \`${message.messageId}\``);
    sessionLines.push(`- _${message.createdAt}_`);
    if (message.feedbackRating) {
      sessionLines.push(`- Feedback: **${message.feedbackRating}**`);
    }
    sessionLines.push("");
    const rawContent = message.content?.trim();
    if (rawContent) {
      const safeContent = redactSecrets(rawContent);
      sessionLines.push("> " + safeContent.replaceAll("\n", "\n> "));
      sessionLines.push("");
    }

    for (const toolResult of message.toolResults ?? []) {
      const { excerpt, truncated } = excerptToolOutput(toolResult);
      if (truncated) sessionTruncatedToolResults += 1;

      sessionLines.push(
        `- **tool** \`${toolResult.toolName ?? toolResult.kind}\` — status: ${toolResult.status}`
      );
      if (toolResult.input) {
        const safeInput = redactSecrets(toolResult.input.slice(0, TOOL_INPUT_EXCERPT_BYTES));
        sessionLines.push("  - input:");
        sessionLines.push(indent(quote(safeInput), 4));
      }
      if (excerpt) {
        sessionLines.push("  - output:");
        sessionLines.push(indent(quote(excerpt), 4));
      }
      sessionLines.push("");
    }
  }
  sessionLines.push("");

  return { sessionLines, sessionTruncatedToolResults };
}

function excerptToolOutput(toolResult: ToolResultRecord): { excerpt: string; truncated: boolean } {
  const raw = toolResult.output ?? "";
  const redacted =
    typeof raw === "string"
      ? (redactSecrets({ output: raw }) as { output: string }).output
      : "";
  if (redacted.length <= TOOL_OUTPUT_EXCERPT_BYTES) {
    return { excerpt: redacted, truncated: false };
  }
  return {
    excerpt:
      redacted.slice(0, TOOL_OUTPUT_EXCERPT_BYTES) +
      `\n…(${redacted.length - TOOL_OUTPUT_EXCERPT_BYTES} bytes elided)`,
    truncated: true
  };
}

function quote(value: string): string {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function indent(value: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export type CorpusBuilderDeps = {
  db: Pool;
  artifacts: ArtifactStore;
  storage: ArtifactStorage;
  loadMessagesForSession: (
    tenantId: string,
    sessionId: string,
    userId: string
  ) => Promise<MessageRecord[]>;
  /**
   * Optional PII gate. When supplied AND the tenant has PII protection
   * effectively enabled for the chat-prompt scope, the assembled corpus is
   * scanned via `evaluateText`. The corpus assembler **fails closed**: any
   * `block` decision or provider error aborts the build before the artifact
   * is written. `transform` rewrites the markdown to the redacted form,
   * `report` attaches finding metadata to the artifact, `allow` is a no-op.
   */
  piiProtection?: PiiProtectionService;
};

export class SkillImprovementCorpusPiiBlockedError extends Error {
  readonly findingsCount: number;
  readonly providerType: string | null;
  readonly providerModel: string | null;
  constructor(message: string, findingsCount: number, providerType: string | null, providerModel: string | null) {
    super(message);
    this.name = "SkillImprovementCorpusPiiBlockedError";
    this.findingsCount = findingsCount;
    this.providerType = providerType;
    this.providerModel = providerModel;
  }
}

export type BuildCorpusInput = {
  tenantId: string;
  userId: string;
  newSessionId: string;
  skill: {
    skillId: string;
    skillName: string;
    description: string | null;
    instructions: string;
  };
  /** Defaults to DEFAULT_SESSIONS, hard-capped at ABSOLUTE_MAX_SESSIONS. */
  sessionLimit?: number;
  /** Defaults to DEFAULT_CORPUS_BYTE_BUDGET. */
  byteBudget?: number;
};

export type BuildCorpusResult = {
  artifact: ArtifactRecord;
  sessionsConsidered: string[];
  includedSessionCount: number;
  excludedSessionCount: number;
  truncatedToolResultCount: number;
  redactionStatus: "applied";
  piiStatus: "skipped" | "allowed" | "transformed" | "reported";
};

/**
 * Queries `resource_activations` for sessions where the target skill was
 * invoked according to either the LLM judge (Tier 3) or `materialized`
 * fallback (Tier 1, used when no judge has run yet). Sessions that the
 * judge explicitly said the skill was NOT invoked in are excluded — those
 * would be misleading evidence for "improve based on what worked".
 *
 * Assembles the formatted markdown, redacts secrets per-message, applies
 * the whole-corpus byte budget, and (when configured) runs the PII
 * protection service. PII `block` decisions or provider errors abort the
 * build before the artifact is written.
 */
export async function buildSkillImprovementCorpus(
  deps: CorpusBuilderDeps,
  input: BuildCorpusInput
): Promise<BuildCorpusResult> {
  const requestedLimit = input.sessionLimit ?? DEFAULT_SESSIONS;
  const sessionLimit = Math.max(0, Math.min(requestedLimit, ABSOLUTE_MAX_SESSIONS));
  const byteBudget = input.byteBudget ?? DEFAULT_CORPUS_BYTE_BUDGET;

  const sessionIds = sessionLimit === 0
    ? []
    : await fetchInvokedSessionIds(deps.db, {
        tenantId: input.tenantId,
        skillId: input.skill.skillId,
        limit: sessionLimit
      });

  const sessions: CorpusSessionInput[] = [];
  for (const row of sessionIds) {
    const messages = await deps.loadMessagesForSession(input.tenantId, row.sessionId, input.userId);
    sessions.push({
      sessionId: row.sessionId,
      sessionName: row.sessionName,
      occurredAt: row.occurredAt,
      messages
    });
  }

  const formatted = formatCorpus({
    skill: input.skill,
    tenantId: input.tenantId,
    generatedAt: new Date().toISOString(),
    sessionLimit,
    sessions,
    byteBudget
  });

  // PII gate — fail-closed before any artifact write. Errors here propagate
  // to the launcher so the admin sees a clear failure instead of a silent
  // PII-leaking artifact.
  let finalMarkdown = formatted.markdown;
  let piiStatus: BuildCorpusResult["piiStatus"] = "skipped";
  let piiMetadata: Record<string, unknown> | null = null;
  if (deps.piiProtection) {
    const subject: PiiSubject = { kind: "chat_prompt" };
    const decision = await deps.piiProtection.evaluateText({
      tenantId: input.tenantId,
      text: formatted.markdown,
      subject
    });
    switch (decision.action) {
      case "allow":
        piiStatus = "allowed";
        break;
      case "report":
        piiStatus = "reported";
        piiMetadata = {
          findingsCount: decision.findings.length,
          providerType: decision.providerType,
          providerModel: decision.providerModel
        };
        break;
      case "transform":
        piiStatus = "transformed";
        finalMarkdown = decision.transformedText;
        piiMetadata = {
          findingsCount: decision.findings.length,
          providerType: decision.providerType,
          providerModel: decision.providerModel
        };
        break;
      case "block":
        throw new SkillImprovementCorpusPiiBlockedError(
          `Corpus blocked by PII protection (reason: ${decision.blockReason}, ${decision.findings.length} finding(s)).`,
          decision.findings.length,
          decision.providerType,
          decision.providerModel
        );
    }
  }

  const contentBuffer = Buffer.from(finalMarkdown, "utf-8");
  const checksumSha256 = createHash("sha256").update(contentBuffer).digest("hex");
  const safeSkillSlug = input.skill.skillId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const artifactName = `skill-improvement-corpus-${safeSkillSlug}-${timestamp}.md`;
  const storageKey = `${input.userId}/${input.newSessionId}/${uuidv7()}.md`;

  const stored = await deps.storage.put({
    storageKey,
    stream: Readable.from([contentBuffer])
  });

  const artifact = await deps.artifacts.create({
    tenantId: input.tenantId,
    artifactType: "generated",
    sessionId: input.newSessionId,
    userId: input.userId,
    artifactName,
    mimeType: "text/markdown",
    storageBackend: stored.storageBackend,
    storageKey: stored.storageKey,
    fileSizeBytes: stored.fileSizeBytes,
    checksumSha256,
    status: "ready",
    createdByType: "system",
    createdByRef: null,
    detail: {
      source: "skill_improvement_corpus",
      skillId: input.skill.skillId,
      sessionLimit,
      includedSessionCount: formatted.includedSessionCount,
      excludedSessionCount: formatted.excludedSessionCount,
      truncatedSessionCount: formatted.excludedSessionCount,
      truncatedToolResultCount: formatted.truncatedToolResultCount,
      byteBudget,
      finalSizeBytes: contentBuffer.length,
      redactionStatus: "applied",
      piiStatus,
      ...(piiMetadata ? { piiCorpusScan: piiMetadata } : {})
    }
  });

  return {
    artifact,
    sessionsConsidered: sessionIds.map((row) => row.sessionId),
    includedSessionCount: formatted.includedSessionCount,
    excludedSessionCount: formatted.excludedSessionCount,
    truncatedToolResultCount: formatted.truncatedToolResultCount,
    redactionStatus: "applied",
    piiStatus
  };
}

type InvokedSessionRow = {
  sessionId: string;
  sessionName: string | null;
  occurredAt: string;
};

/**
 * Returns up to `limit` sessions where `resource_activations` has at least
 * one `invoked` row for the target skill, OR a `materialized` row in the
 * absence of any LLM-judge negative ruling. Sessions where the LLM judge
 * explicitly said the skill was NOT invoked are filtered out — including
 * them would feed the improver evidence that contradicts its task.
 *
 * Sessions are returned newest-first by the most recent matching activation.
 */
async function fetchInvokedSessionIds(
  db: Pool,
  input: { tenantId: string; skillId: string; limit: number }
): Promise<InvokedSessionRow[]> {
  return withTenantScope(db, input.tenantId, async (client) => {
    const result = await client.query(
      `
        WITH per_session AS (
          SELECT
            ra.session_id,
            MAX(ra.occurred_at) AS last_occurred_at,
            BOOL_OR(ra.event_type = 'invoked') AS had_invoked,
            -- Judge-negative: the LLM judge wrote a 'materialized' row whose
            -- metadata explicitly says invoked=false. Persisted by
            -- session-judge-worker.persistJudgment for skills the judge
            -- decided were NOT used; they must not feed the improver corpus.
            BOOL_OR(
              ra.event_type = 'materialized'
              AND ra.metadata ->> 'source' = 'llm_judge'
              AND ra.metadata ->> 'invoked' = 'false'
            ) AS judge_negative
          FROM resource_activations ra
          WHERE ra.tenant_id = $1
            AND ra.resource_type = 'skill'
            AND ra.resource_id = $2
            AND ra.event_type IN ('invoked', 'materialized')
          GROUP BY ra.session_id
        )
        SELECT
          s.session_id,
          s.session_name,
          per_session.last_occurred_at
        FROM per_session
        JOIN sessions s ON s.session_id = per_session.session_id AND s.tenant_id = $1
        WHERE s.purpose = 'normal'  -- never feed improver sessions back into themselves
          AND NOT per_session.judge_negative
        ORDER BY per_session.had_invoked DESC, per_session.last_occurred_at DESC
        LIMIT $3
      `,
      [input.tenantId, input.skillId, input.limit]
    );

    return result.rows.map((row) => ({
      sessionId: String(row.session_id),
      sessionName: row.session_name ? String(row.session_name) : null,
      occurredAt: new Date(String(row.last_occurred_at)).toISOString()
    }));
  });
}
