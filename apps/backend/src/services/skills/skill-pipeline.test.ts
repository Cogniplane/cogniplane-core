import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { test, expect, onTestFinished } from "vitest";

import type {
  AdminSkillRecord,
  ImportedSkillBundleRecord,
  ResolvedRuntimePolicy
} from "../admin-config-records.js";
import { compileRuntimeConfig } from "../dynamic-config-runtime-compiler.js";
import { createRuntimeWorkspace } from "../runtime/runtime-workspace.js";
import { LocalSkillBundleStorage } from "./skill-bundle-storage.js";
import { importSkillBundleFromInline } from "./skill-import-service.js";
import { createTestConfig } from "../../test-helpers/test-config.js";

const TENANT_ID = "tenant-pipeline";
const SKILL_ID = "pipeline-test";
const SKILL_NAME = "Pipeline Test Skill";
const SKILL_DESCRIPTION = "Verifies the import → compile → workspace path.";
const SKILL_INSTRUCTIONS = "When asked about the pipeline, respond with the exact phrase 'pipeline confirmed'.";

function buildResolvedProfile(): ResolvedRuntimePolicy {
  return {
    id: "test-profile",
    label: "Test profile",
    description: null,
    runtimeProvider: "codex",
    approvalPolicy: "on-request",
    approvalReviewer: "user",
    sandboxMode: "workspace-write",
    networkMode: "restricted",
    allowCommandExecution: false,
    allowUserTokenForwarding: false,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor",
    developerInstructions: null,
    enabledToolIds: [],
    enabledMcpServers: [],
    version: 1,
    hash: "hash-test-profile"
  };
}

test("skill pipeline: imported bundle reaches workspace SKILL.md unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-pipeline-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  // Step 1: import a minimal inline bundle. The inline path runs
  // `validateSkillBundle` internally and yields the record shape the
  // skill-revisions store would produce after a real INSERT + active-revision
  // update. We capture that record below and feed it directly to the runtime
  // compiler, simulating an already-activated revision without needing a DB.
  let captured: AdminSkillRecord | null = null;
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
      captured = skill;
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
          reviewedBy: null,
          reviewedAt: null,
          activatedAt: new Date().toISOString()
        }
      };
    }
  };

  await importSkillBundleFromInline({
    tenantId: TENANT_ID,
    skillRevisions: fakeSkillRevisions,
    skillId: SKILL_ID,
    skillName: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    instructions: SKILL_INSTRUCTIONS,
    actorUserId: "test-actor"
  });

  expect(captured).toBeTruthy();
  const importedSkill = captured as AdminSkillRecord;
  expect(importedSkill.instructions).toMatch(/pipeline confirmed/);

  // Step 2: compile a runtime config from the imported skill. `compileRuntimeConfig`
  // consumes a `Pick<SkillConfigStore, "listSkills">` so the in-memory record is
  // sufficient — no Postgres or RLS in the loop.
  const runtimeConfig = await compileRuntimeConfig({
    tenantId: TENANT_ID,
    runtimePolicy: buildResolvedProfile(),
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

  // Step 3: materialize the workspace and assert the rendered SKILL.md still
  // carries the original instructions.
  const workspace = await createRuntimeWorkspace(
    {
      ...createTestConfig(),
      RUNTIME_WORKSPACE_ROOT: path.join(root, "workspaces")
    },
    {
      sessionId: "44444444-4444-4444-4444-444444444444",
      tenantId: TENANT_ID,
      userId: "test-user",
      runtimeId: "runtime-pipeline",
      runtimeConfig,
      skillBundleStorage: new LocalSkillBundleStorage(path.join(root, "bundle-cache"))
    }
  );

  const renderedSkillPath = path.join(
    workspace.manifest.config.skillsPath,
    SKILL_ID,
    "SKILL.md"
  );
  const rendered = await readFile(renderedSkillPath, "utf8");
  expect(rendered).toMatch(/pipeline confirmed/);
  expect(rendered).toMatch(new RegExp(SKILL_ID));
});
