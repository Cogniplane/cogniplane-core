import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { MessageStore } from "../message-store.js";
import type { SessionStore } from "../session-store.js";
import type { RuntimeProvider } from "../admin-config-records.js";
import type { RuntimeReasoningEffort } from "../../runtime-contracts.js";
import { AVAILABLE_MODELS } from "../../domain/models.js";
import type { PiiProtectionService } from "../pii/pii-protection-service.js";
import type { SessionRuntimeOverrideStore } from "../session-runtime-override-store.js";
import type { SkillImprovementSessionRecord, SkillImprovementSessionStore } from "./skill-improvement-session-store.js";
import {
  buildSkillImprovementCorpus,
  SkillImprovementCorpusPiiBlockedError
} from "./skill-improvement-corpus.js";
import { type Pool } from "../../lib/db.js";

export const SKILL_IMPROVER_SKILL_ID = "skill-improver";

/**
 * Tool/MCP allowlist baked into every improver session. Mirrors plan §1a:
 *   skills: [skill-improver]
 *   mcp:    [managed-session-context]
 *   tools:  [session_context, list_artifacts, read_text_artifact, write_artifact]
 *   approval: never
 *   autoApproveReadOnlyTools: true
 *
 * Kept here (not in the override row insert) so admins can audit the
 * constraint via a single export.
 */
export const SKILL_IMPROVEMENT_OVERRIDE = Object.freeze({
  enabledSkillIds: ["skill-improver"],
  enabledMcpServerIds: ["managed-session-context"],
  enabledToolIds: ["session_context", "list_artifacts", "read_text_artifact", "write_artifact"],
  approvalPolicy: "never" as const,
  autoApproveReadOnlyTools: true
});

export class SkillImprovementSkillNotEditableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillImprovementSkillNotEditableError";
  }
}

export class SkillImprovementSkillNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillImprovementSkillNotFoundError";
  }
}

/**
 * Server-side rejection of a launch request whose runtime selection
 * doesn't match what the tenant is allowed to use. Surfaced as a 400 with
 * a stable code so the frontend can map it back to a field error.
 */
export class SkillImprovementRuntimeNotAllowedError extends Error {
  readonly field: "provider" | "model" | "effort" | "anthropic_api_key";
  constructor(field: SkillImprovementRuntimeNotAllowedError["field"], message: string) {
    super(message);
    this.name = "SkillImprovementRuntimeNotAllowedError";
    this.field = field;
  }
}

export type LaunchSkillImprovementInput = {
  tenantId: string;
  userId: string;
  skillId: string;
  sessionLimit: number;
  provider: RuntimeProvider | null;
  model: string | null;
  effort: string | null;
};

export type LaunchSkillImprovementResult = {
  sessionId: string;
  artifactId: string | null;
  link: SkillImprovementSessionRecord;
  includedSessionCount: number;
  excludedSessionCount: number;
  truncatedToolResultCount: number;
};

export type SkillImprovementLauncherDeps = {
  db: Pool;
  dynamicConfig: DynamicConfigService;
  sessions: SessionStore;
  sessionRuntimeOverrides: SessionRuntimeOverrideStore;
  skillImprovementSessions: SkillImprovementSessionStore;
  artifacts: ArtifactStore;
  artifactStorage: ArtifactStorage;
  messages: MessageStore;
  /**
   * Optional. When supplied, the launcher refuses to create a Claude
   * session if the tenant has no Anthropic key configured. Codex is
   * never gated on this.
   */
  hasAnthropicApiKey?: (tenantId: string) => Promise<boolean>;
  /**
   * Optional. When supplied, the corpus assembler runs the resulting
   * markdown through the PII protection service before writing the
   * artifact. Failures are surfaced to the admin instead of silently
   * persisting potentially sensitive content.
   */
  piiProtection?: PiiProtectionService;
  logger?: { error(meta: object, msg: string): void };
};

/**
 * Launches an improver session for a skill the admin owns:
 *   1. Validate the skill exists, is editable, and is not a system skill.
 *   2. Validate the requested (provider, model, effort) are usable by the
 *      tenant — provider must be in `enabledRuntimeProviders`, model must
 *      belong to that provider, effort must be supported by the model,
 *      and Claude requires an Anthropic key.
 *   3. Create a session row with purpose='skill_improvement'.
 *   4. Insert the per-session runtime override that locks the session to
 *      corpus-reading + write_artifact.
 *   5. Build the corpus artifact and scope it to the new session.
 *   6. Insert the link row in skill_improvement_sessions.
 *
 * Steps 3-6 are not a single DB transaction (`buildSkillImprovementCorpus`
 * also calls into S3-backed storage), so failures past step 3 trigger
 * compensation: the session is soft-deleted, the override row is removed
 * by the session's CASCADE, and any stored artifact blob is best-effort
 * cleaned up. The admin sees a clear failure instead of an orphaned
 * session row with no link or context.
 */
export async function launchSkillImprovementSession(
  deps: SkillImprovementLauncherDeps,
  input: LaunchSkillImprovementInput
): Promise<LaunchSkillImprovementResult> {
  const skills = await deps.dynamicConfig.listSkills(input.tenantId, true);
  const skill = skills.find((s) => s.skillId === input.skillId);
  if (!skill) {
    throw new SkillImprovementSkillNotFoundError(`Skill "${input.skillId}" not found.`);
  }
  if (skill.isInherited) {
    // System skills cannot be edited from a tenant context (see
    // dynamic-config-service.ts importSkillBundleFromInline) — improving
    // them would require cross-tenant aggregation, which is out of scope
    // for v1. Tenant must clone the skill first.
    throw new SkillImprovementSkillNotEditableError(
      `Skill "${input.skillId}" is inherited from the system tenant and cannot be improved directly. ` +
        "Clone it first via the inline import flow."
    );
  }

  // R4: server-side validation of provider/model/effort/key. The frontend
  // already filters options, but a malicious or stale client must not be
  // able to spin up a runtime the tenant isn't paying for.
  await validateRuntimeSelection(deps, input);

  const sessionName = `Improve: ${skill.skillName}`;
  const session = await deps.sessions.create(input.tenantId, input.userId, sessionName, {
    purpose: "skill_improvement"
  });

  // From here on, any failure must compensate so we don't leak
  // half-configured improver sessions into the admin's session list.
  let storedArtifactId: string | null = null;
  try {
    await deps.sessionRuntimeOverrides.upsert(input.tenantId, session.sessionId, {
      runtimeProvider: input.provider,
      enabledSkillIds: [...SKILL_IMPROVEMENT_OVERRIDE.enabledSkillIds],
      enabledMcpServerIds: [...SKILL_IMPROVEMENT_OVERRIDE.enabledMcpServerIds],
      enabledToolIds: [...SKILL_IMPROVEMENT_OVERRIDE.enabledToolIds],
      approvalPolicy: SKILL_IMPROVEMENT_OVERRIDE.approvalPolicy,
      autoApproveReadOnlyTools: SKILL_IMPROVEMENT_OVERRIDE.autoApproveReadOnlyTools,
      createdBy: input.userId
    });

    const corpus = await buildSkillImprovementCorpus(
      {
        db: deps.db,
        artifacts: deps.artifacts,
        storage: deps.artifactStorage,
        loadMessagesForSession: (tenantId, sessionId, userId) =>
          deps.messages.listBySession(tenantId, sessionId, userId),
        piiProtection: deps.piiProtection
      },
      {
        tenantId: input.tenantId,
        userId: input.userId,
        newSessionId: session.sessionId,
        sessionLimit: input.sessionLimit,
        skill: {
          skillId: skill.skillId,
          skillName: skill.skillName,
          description: skill.description,
          instructions: skill.instructions
        }
      }
    );
    storedArtifactId = corpus.artifact.artifactId;

    const link = await deps.skillImprovementSessions.create(input.tenantId, session.sessionId, {
      skillId: skill.skillId,
      corpusArtifactId: corpus.artifact.artifactId,
      sessionLimit: input.sessionLimit,
      model: input.model,
      effort: input.effort,
      createdBy: input.userId
    });

    return {
      sessionId: session.sessionId,
      artifactId: corpus.artifact.artifactId,
      link,
      includedSessionCount: corpus.includedSessionCount,
      excludedSessionCount: corpus.excludedSessionCount,
      truncatedToolResultCount: corpus.truncatedToolResultCount
    };
  } catch (err) {
    await compensateFailedLaunch(deps, {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: session.sessionId,
      artifactId: storedArtifactId
    });
    if (err instanceof SkillImprovementCorpusPiiBlockedError) {
      // Re-throw as a config error so the route returns a clean 400
      // instead of a 500 stack trace.
      throw new SkillImprovementSkillNotEditableError(err.message);
    }
    throw err;
  }
}

async function validateRuntimeSelection(
  deps: SkillImprovementLauncherDeps,
  input: LaunchSkillImprovementInput
): Promise<void> {
  const settings = await deps.dynamicConfig.getOrCreateTenantSettings(input.tenantId);
  const enabledProviders = settings.enabledRuntimeProviders;

  // Resolve the provider the request is asking for. The model wins if
  // both are supplied — same precedence as `routes/messages.ts` so the
  // first improver turn behaves the same as a normal turn.
  let resolvedProvider: RuntimeProvider | null = input.provider ?? null;
  let resolvedModel: (typeof AVAILABLE_MODELS)[number] | null = null;

  if (input.model) {
    resolvedModel = AVAILABLE_MODELS.find((m) => m.id === input.model) ?? null;
    if (!resolvedModel) {
      throw new SkillImprovementRuntimeNotAllowedError(
        "model",
        `Model "${input.model}" is not a known model.`
      );
    }
    if (resolvedProvider && resolvedModel.provider !== resolvedProvider) {
      throw new SkillImprovementRuntimeNotAllowedError(
        "model",
        `Model "${input.model}" is not available for the "${resolvedProvider}" runtime provider.`
      );
    }
    resolvedProvider = resolvedModel.provider;
  }

  if (!resolvedProvider) resolvedProvider = settings.runtimeProvider;

  if (!enabledProviders.includes(resolvedProvider)) {
    throw new SkillImprovementRuntimeNotAllowedError(
      "provider",
      `Runtime provider "${resolvedProvider}" is not enabled for this tenant.`
    );
  }

  if (resolvedProvider === "claude-code" && deps.hasAnthropicApiKey) {
    if (!(await deps.hasAnthropicApiKey(input.tenantId))) {
      throw new SkillImprovementRuntimeNotAllowedError(
        "anthropic_api_key",
        "Claude models are enabled for this tenant but no Anthropic API key is available."
      );
    }
  }

  if (input.effort) {
    if (!resolvedModel) {
      // No specific model requested — fall back to the provider's default
      // so we can still validate the effort against something concrete.
      resolvedModel =
        AVAILABLE_MODELS.find((m) => m.provider === resolvedProvider && m.isDefault) ??
        AVAILABLE_MODELS.find((m) => m.provider === resolvedProvider) ??
        null;
    }
    if (
      resolvedModel &&
      !resolvedModel.supportedEfforts.includes(input.effort as RuntimeReasoningEffort)
    ) {
      throw new SkillImprovementRuntimeNotAllowedError(
        "effort",
        `Effort "${input.effort}" is not supported by model "${resolvedModel.id}".`
      );
    }
  }
}

async function compensateFailedLaunch(
  deps: SkillImprovementLauncherDeps,
  ctx: {
    tenantId: string;
    userId: string;
    sessionId: string;
    artifactId: string | null;
  }
): Promise<void> {
  // Best-effort cleanup. Each step is independent — we never want a
  // compensation failure to mask the original error, but we do log so a
  // silently swallowed cleanup leaves an operational trail.
  //
  // Storage blob: we don't try to delete the underlying S3/local blob.
  // ArtifactStorage has no remove() in its interface, and orphaned blobs
  // are tolerable (they're not user-visible). Soft-deleting the artifact
  // row is enough to keep them out of the session checkbox UI.
  if (ctx.artifactId) {
    try {
      await deps.artifacts.update(ctx.tenantId, ctx.artifactId, { status: "deleted" });
    } catch (cleanupErr) {
      deps.logger?.error(
        {
          cleanupErr,
          tenantId: ctx.tenantId,
          artifactId: ctx.artifactId,
          sessionId: ctx.sessionId
        },
        "skill-improvement compensation: failed to soft-delete artifact"
      );
    }
  }
  try {
    // Session removal cascades the runtime override via FK ON DELETE
    // CASCADE on session_runtime_overrides; nothing else to clean up.
    await deps.sessions.remove(ctx.tenantId, ctx.sessionId, ctx.userId);
  } catch (cleanupErr) {
    deps.logger?.error(
      {
        cleanupErr,
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        userId: ctx.userId
      },
      "skill-improvement compensation: failed to remove session"
    );
  }
}
