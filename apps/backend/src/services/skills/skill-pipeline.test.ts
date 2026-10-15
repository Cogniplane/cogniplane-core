import { test, expect } from "vitest";
import { buildSkillsLibraryFiles } from "../deep-agents/deep-agents-skills-library.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";

import type {
  AdminSkillRecord,
  ImportedSkillBundleRecord,
  ResolvedRuntimePolicy
} from "../admin-config-records.js";
import { compileRuntimeConfig } from "../dynamic-config-runtime-compiler.js";
import { importSkillBundleFromInline } from "./skill-import-service.js";

const TENANT_ID = "tenant-pipeline";
const SKILL_ID = "pipeline-test";
const SKILL_NAME = "Pipeline Test Skill";
const SKILL_DESCRIPTION = "Verifies the import to runtime library path.";
const SKILL_INSTRUCTIONS = "When asked about the pipeline, respond with the exact phrase 'pipeline confirmed'.";

function buildResolvedProfile(): ResolvedRuntimePolicy {
  return {
    id: "test-profile",
    label: "Test profile",
    description: null,
    webSearchMode: "disabled",
    approvalPolicy: "on-request",
    approvalReviewer: "user",
    sandboxMode: "workspace-write",
    sandboxEgressDomains: [],
    allowCommandExecution: false,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor",
    developerInstructions: null,
    enabledToolIds: [],
    enabledMcpServers: [],
    version: 1,
    hash: "hash-test-profile"
  };
}

test("skill pipeline: imported instructions reach the in-memory library SKILL.md unchanged", async () => {
  // Step 1: import a minimal inline bundle. The inline path runs
  // `validateSkillBundle` internally and yields the record shape the
  // skill-revisions store would produce after a real INSERT + active-revision
  // update. The fake returns that record and feeds it directly to the runtime
  // compiler, simulating an already-activated revision without needing a DB.
  const fakeSkillRevisions = {
    async importSkillBundle(_tenantId: string, input: {
      skillId: string;
      skillName: string;
      description: string;
      instructions: string;
      bundleHash: string;
      sourceType: string;
      bundleName: string;
      validationStatus: string;
      metadata: Record<string, unknown>;
      createdBy: string;
      storeBundle: (input: { revisionNumber: number }) => Promise<{ storageUri: string | null }>;
    }): Promise<ImportedSkillBundleRecord> {
      const { storageUri } = await input.storeBundle({ revisionNumber: 1 });
      const skill: AdminSkillRecord = {
        skillId: input.skillId,
        skillName: input.skillName,
        description: input.description,
        instructions: input.instructions,
        version: 1,
        contentHash: input.bundleHash,
        enabled: true,
        isPublished: true,
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        activeRevisionId: 1,
        activeSourceType: input.sourceType,
        activeBundleName: input.bundleName,
        activeBundleStorageUri: storageUri,
        activeBundleHash: input.bundleHash,
        activeValidationStatus: input.validationStatus,
        activeReviewStatus: "active",
        isInherited: false
      };
      return {
        skill,
        revision: {
          skillRevisionId: 1,
          skillId: input.skillId,
          revisionNumber: 1,
          sourceType: input.sourceType,
          sourceLabel: input.sourceType,
          bundleName: input.bundleName,
          bundleStorageUri: storageUri,
          bundleHash: input.bundleHash,
          validationStatus: input.validationStatus,
          validationMessages: [],
          reviewStatus: "active",
          reviewNotes: null,
          metadata: input.metadata,
          createdBy: input.createdBy,
          createdAt: new Date().toISOString(),
          reviewedBy: null,
          reviewedAt: null,
          activatedAt: new Date().toISOString()
        }
      };
    }
  };

  const imported = await importSkillBundleFromInline({
    tenantId: TENANT_ID,
    skillRevisions: fakeSkillRevisions,
    skillId: SKILL_ID,
    skillName: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    instructions: SKILL_INSTRUCTIONS,
    actorUserId: "test-actor"
  });

  const importedSkill = imported.skill;
  expect(importedSkill.instructions).toBe(SKILL_INSTRUCTIONS);

  // Step 2: compile a runtime config from the imported skill. `compileRuntimeConfig`
  // consumes a `Pick<SkillConfigStore, "listSkills">` so the in-memory record is
  // sufficient — no Postgres or RLS in the loop.
  const runtimeConfig = await compileRuntimeConfig({
    tenantId: TENANT_ID,
    runtimePolicy: buildResolvedProfile(),
    isBetaTester: true,
    skills: {
      async listSkills() {
        return [importedSkill];
      }
    },
    mcpServers: {
      async listMcpServers() {
        return [];
      }
    }
  });

  expect(runtimeConfig.skills.length).toBe(1);
  expect(runtimeConfig.skills[0]?.id).toBe(SKILL_ID);

  const files = await buildSkillsLibraryFiles({ skills: runtimeConfig.skills, logger: createSilentLogger() });
  const markdown = files["/pipeline-test-skill/SKILL.md"]?.content;
  expect(typeof markdown).toBe("string");
  const body = (markdown as string).replace(/^---\n[\s\S]*?\n---\n\n/, "");
  expect(body).toBe(`${SKILL_INSTRUCTIONS}\n`);
});
