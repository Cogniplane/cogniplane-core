import type { AppConfig } from "../../config.js";
import { getCleanupDecision, getLatestRevisionIds } from "../../domain/skill-cleanup-policy.js";

import type { SkillConfigStore } from "./skill-config-store.js";
import type { SkillRevisionStore } from "./skill-revision-store.js";
import type { SkillBundleStorage } from "./skill-bundle-storage.js";
import type { SkillRevisionCleanupReport } from "../admin-config-records.js";

export async function cleanupInactiveSkillRevisions(input: {
  tenantId: string;
  config: AppConfig;
  skills: SkillConfigStore;
  skillRevisions: SkillRevisionStore;
  skillBundleStorage: SkillBundleStorage;
  dryRun?: boolean;
}): Promise<SkillRevisionCleanupReport> {
  const dryRun = input.dryRun ?? false;
  const retentionCutoff =
    Date.now() - input.config.SKILL_BUNDLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const [skills, revisions, activeRuntimeReferences] = await Promise.all([
    input.skills.listSkills(input.tenantId, true),
    input.skillRevisions.listAllSkillRevisions(input.tenantId),
    input.skillRevisions.listActiveRuntimeSkillReferences(input.tenantId)
  ]);

  const activeRevisionIds = new Set(
    skills
      .map((skill) => skill.activeRevisionId)
      .filter((revisionId): revisionId is number => revisionId !== null)
  );
  const activeRuntimeRevisionIds = new Set(
    activeRuntimeReferences
      .map((reference) => reference.revisionId)
      .filter((revisionId): revisionId is number => revisionId !== null)
  );
  const latestRevisionIds = getLatestRevisionIds(revisions);

  const report: SkillRevisionCleanupReport = {
    dryRun,
    deletedRevisionIds: [],
    deletedBundleStorageUris: [],
    keptRevisionDecisions: [],
    failures: []
  };

  for (const revision of revisions) {
    const decision = getCleanupDecision({
      revision,
      activeRevisionIds,
      activeRuntimeReferences,
      activeRuntimeRevisionIds,
      latestRevisionIds,
      retentionCutoff
    });

    if (decision.retain) {
      report.keptRevisionDecisions.push({
        skillRevisionId: revision.skillRevisionId,
        reason: decision.reason ?? "retained"
      });
      continue;
    }

    if (dryRun) {
      report.deletedRevisionIds.push(revision.skillRevisionId);
      if (revision.bundleStorageUri) {
        report.deletedBundleStorageUris.push(revision.bundleStorageUri);
      }
      continue;
    }

    try {
        const deletedRevision = await input.skillRevisions.deleteSkillRevision(
          input.tenantId,
          revision.skillId,
          revision.skillRevisionId
        );
      if (!deletedRevision) {
        report.failures.push({
          skillRevisionId: revision.skillRevisionId,
          reason: "Revision could not be deleted."
        });
        continue;
      }

      report.deletedRevisionIds.push(deletedRevision.skillRevisionId);
      if (deletedRevision.bundleStorageUri) {
          const remainingReferences = await input.skillRevisions.countSkillRevisionsByBundleStorageUri(
            input.tenantId,
            deletedRevision.bundleStorageUri
          );
        if (remainingReferences === 0) {
          await input.skillBundleStorage.deleteBundle(deletedRevision.bundleStorageUri);
          report.deletedBundleStorageUris.push(deletedRevision.bundleStorageUri);
        }
      }
    } catch (error) {
      report.failures.push({
        skillRevisionId: revision.skillRevisionId,
        reason: error instanceof Error ? error.message : "Revision cleanup failed."
      });
    }
  }

  report.deletedBundleStorageUris = [...new Set(report.deletedBundleStorageUris)].sort();
  return report;
}
