import type { Pool } from "../../lib/db.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { MessageStore } from "../message-store.js";
import type { PiiProtectionService } from "../pii/pii-protection-service.js";
import { gatherSkillCorpus } from "../skills/skill-improvement-corpus.js";
import { allRequiredObjectSchema, type ManagedToolDefinition } from "./types.js";

type SkillCorpusToolDeps = {
  db: Pool;
  dynamicConfig: DynamicConfigService;
  messages: MessageStore;
  /**
   * Optional PII gate forwarded to `gatherSkillCorpus`. When present, the
   * assembled corpus is evaluated fail-closed before being returned — a
   * `block` decision throws and the runtime sees a tool error, never the
   * sensitive content.
   */
  piiProtection?: PiiProtectionService;
};

// ── Catalog entry (static metadata consumed by ./catalog) ────────────────────

export const SKILL_CORPUS_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "read_skill_corpus",
    description:
      "Read a redacted corpus of recent sessions where a skill was offered or used, plus the skill's current SKILL.md. Use this when asked to improve a skill: read the corpus, then propose an improved SKILL.md.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        skillId: { type: "string" },
        sessionCount: { type: "integer", minimum: 0, maximum: 200 }
      },
      required: ["toolContextId", "skillId"],
      additionalProperties: false
    }
  }
];

// ── Tool definition ──────────────────────────────────────────────────────────

export function createSkillCorpusTool(deps: SkillCorpusToolDeps): ManagedToolDefinition[] {
  return [
    {
      ...SKILL_CORPUS_TOOL_CATALOG[0],
      outputSchema: allRequiredObjectSchema({
        skillId: { type: "string" },
        skillName: { type: "string" },
        corpusMarkdown: { type: "string" },
        includedSessionCount: { type: "integer" },
        excludedSessionCount: { type: "integer" },
        truncatedToolResultCount: { type: "integer" }
      }),
      handler: async ({ context, arguments: args }) => {
        const skillId = String(args.skillId ?? "");
        if (!skillId) throw new Error("skillId is required.");

        // Tenant-scoped skill lookup. `listSkills(tenantId, true)` returns
        // active + inherited skills; the corpus reads the active revision's
        // instructions, so a skill with no activatable revision is rejected.
        const skills = await deps.dynamicConfig.listSkills(context.tenantId, true);
        const skill = skills.find((s) => s.skillId === skillId);
        if (!skill) throw new Error(`Skill "${skillId}" not found.`);

        // Preserve an explicit `sessionCount: 0` (return only the current
        // SKILL.md / empty corpus). A bare `|| 50` would coerce 0 → 50.
        const rawCount = args.sessionCount;
        const parsedCount = typeof rawCount === "number" && Number.isFinite(rawCount) ? rawCount : 50;
        const sessionCount = Math.max(0, Math.min(200, Math.trunc(parsedCount)));

        const corpus = await gatherSkillCorpus(
          {
            db: deps.db,
            loadMessagesForSession: (tenantId, sessionId, userId) =>
              deps.messages.listBySession(tenantId, sessionId, userId),
            piiProtection: deps.piiProtection
          },
          {
            tenantId: context.tenantId,
            userId: context.userId,
            sessionLimit: sessionCount,
            skill: {
              skillId: skill.skillId,
              skillName: skill.skillName,
              description: skill.description,
              instructions: skill.instructions
            }
          }
        );

        return {
          skillId: skill.skillId,
          skillName: skill.skillName,
          corpusMarkdown: corpus.markdown,
          includedSessionCount: corpus.includedSessionCount,
          excludedSessionCount: corpus.excludedSessionCount,
          truncatedToolResultCount: corpus.truncatedToolResultCount
        };
      }
    }
  ];
}
