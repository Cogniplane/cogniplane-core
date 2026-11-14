import type { AppConfig } from "../../config.js";
import { getCleanupDecision, getLatestRevisionIds } from "../../domain/skill-cleanup-policy.js";

import type { SkillConfigStore } from "./skill-config-store.js";
import type { SkillRevisionStore } from "./skill-revision-store.js";
import type { SkillRevisionCleanupReport } from "../admin-config-records.js";
import type { StorageGc, StorageGcOutcome } from "../storage/storage-gc.js";

/**
 * Deletes the revisions that the cleanup policy does not keep. Each delete
 * queues its bundle in its own transaction; this call then deletes the bundle
 * when no revision of any tenant names it. A bundle delete that fails stays
 * queued: the scheduler worker retries it, and so does the next cleanup.
 */
export async function cleanupInactiveSkillRevisions(input: {
  tenantId: string;
  config: Pick<AppConfig, "SKILL_BUNDLE_RETENTION_DAYS">;
  skills: Pick<SkillConfigStore, "listSkills">;
  skillRevisions: Pick<
    SkillRevisionStore,
    | "listAllSkillRevisions"
    | "listActiveRuntimeSkillReferences"
    | "listAcceptedSubmissionRevisions"
    | "deleteSkillRevision"
  >;
  bundleGc: Pick<StorageGc, "collectSkillBundle" | "retryTenantSkillBundles">;
  dryRun?: boolean;
}): Promise<SkillRevisionCleanupReport> {
  const dryRun = input.dryRun ?? false;
  const retentionCutoff =
    Date.now() - input.config.SKILL_BUNDLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const report: SkillRevisionCleanupReport = {
    dryRun,
    deletedRevisionIds: [],
    deletedBundleStorageUris: [],
    pendingBundleStorageUris: [],
    keptRevisionDecisions: [],
    failures: []
  };
  const recordBundle = (storageUri: string, outcome: StorageGcOutcome) => {
    if (outcome === "deleted") report.deletedBundleStorageUris.push(storageUri);
    if (outcome === "pending") report.pendingBundleStorageUris.push(storageUri);
  };

  // First the bundles that an earlier cleanup queued, so a bundle queued
  // below is not tried twice in one call.
  if (!dryRun) {
    for (const [storageUri, outcome] of await input.bundleGc.retryTenantSkillBundles(input.tenantId)) {
      recordBundle(storageUri, outcome);
    }
  }

  const [skills, revisions, activeRuntimeReferences, acceptedSubmissions] = await Promise.all([
    input.skills.listSkills(input.tenantId, true),
    input.skillRevisions.listAllSkillRevisions(input.tenantId),
    input.skillRevisions.listActiveRuntimeSkillReferences(input.tenantId),
    input.skillRevisions.listAcceptedSubmissionRevisions(input.tenantId)
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
  const acceptedSubmissionsByRevisionId = new Map<number, string[]>();
  for (const accepted of acceptedSubmissions) {
    const submissionIds = acceptedSubmissionsByRevisionId.get(accepted.revisionId) ?? [];
    submissionIds.push(accepted.submissionId);
    acceptedSubmissionsByRevisionId.set(accepted.revisionId, submissionIds);
  }

  for (const revision of revisions) {
    const decision = getCleanupDecision({
      revision,
      activeRevisionIds,
      activeRuntimeReferences,
      activeRuntimeRevisionIds,
      latestRevisionIds,
      acceptedSubmissionsByRevisionId,
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

    let deletedRevision;
    try {
      deletedRevision = await input.skillRevisions.deleteSkillRevision(
        input.tenantId,
        revision.skillId,
        revision.skillRevisionId
      );
    } catch (error) {
      report.failures.push({
        skillRevisionId: revision.skillRevisionId,
        reason: error instanceof Error ? error.message : "Revision cleanup failed."
      });
      continue;
    }
    if (!deletedRevision) {
      // The final delete found a safeguard that the policy read missed (an
      // activation, a release or an acceptance in the meantime).
      report.failures.push({
        skillRevisionId: revision.skillRevisionId,
        reason: "Revision could not be deleted."
      });
      continue;
    }

    report.deletedRevisionIds.push(deletedRevision.skillRevisionId);
    // The delete committed with a queue row for the bundle. No lock with
    // imports is needed for the delete: an import stores each bundle at a new
    // location (storeBundle), so no revision starts to use a location after
    // its last reference is gone.
    if (deletedRevision.bundleStorageUri) {
      recordBundle(
        deletedRevision.bundleStorageUri,
        await input.bundleGc.collectSkillBundle({
          tenantId: input.tenantId,
          storageUri: deletedRevision.bundleStorageUri
        })
      );
    }
  }

  report.deletedBundleStorageUris = [...new Set(report.deletedBundleStorageUris)].sort();
  const deleted = new Set(report.deletedBundleStorageUris);
  report.pendingBundleStorageUris = [...new Set(report.pendingBundleStorageUris)]
    .filter((storageUri) => !deleted.has(storageUri))
    .sort();
  return report;
}
