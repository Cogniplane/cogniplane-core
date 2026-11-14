import { test, expect } from "vitest";

import type { AdminSkillRecord, AdminSkillRevisionRecord } from "../admin-config-records.js";

import type { StorageGcOutcome } from "../storage/storage-gc.js";
import { cleanupInactiveSkillRevisions } from "./skill-revision-cleanup-service.js";

type CleanupInput = Parameters<typeof cleanupInactiveSkillRevisions>[0];
type CapturedStores = Pick<CleanupInput, "skills" | "skillRevisions" | "bundleGc"> & {
  deletedRevisions: number[];
  deletedBundles: string[];
  /** The outcome of the queued bundle delete, by URI; "deleted" when absent. */
  bundleOutcomes: Map<string, StorageGcOutcome>;
  /** Bundles that an earlier cleanup queued: the retry outcome by URI. */
  queuedBundles: Map<string, StorageGcOutcome>;
  calls: string[];
};

function rev(o: Partial<AdminSkillRevisionRecord>): AdminSkillRevisionRecord {
  return {
    skillRevisionId: 1,
    skillId: "sk1",
    revisionNumber: 1,
    sourceType: "github",
    sourceLabel: null,
    bundleName: null,
    bundleStorageUri: "s3://bkt/sk1/v1",
    bundleHash: "h",
    validationStatus: "valid",
    validationMessages: [],
    reviewStatus: "approved",
    reviewNotes: null,
    metadata: {},
    createdBy: "u",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365).toISOString(), // 1y ago
    reviewedBy: null,
    reviewedAt: null,
    activatedAt: null,
    ...o
  };
}

function skill(o: Partial<AdminSkillRecord>): AdminSkillRecord {
  return {
    skillId: "sk1",
    skillName: "Skill",
    description: null,
    instructions: "Instructions",
    version: 1,
    contentHash: "hash",
    enabled: true,
    isPublished: false,
    createdBy: "u",
    activeRevisionId: 1,
    activeSourceType: "github",
    activeBundleName: "sk1",
    activeBundleStorageUri: "s3://bkt/sk1/v1",
    activeBundleHash: "h",
    activeValidationStatus: "valid",
    activeReviewStatus: "approved",
    createdAt: "now",
    updatedAt: "now",
    isInherited: false,
    ...o
  };
}

const config = {
  SKILL_BUNDLE_RETENTION_DAYS: 30
} satisfies CleanupInput["config"];

function captureStores(): CapturedStores {
  const deletedRevisions: number[] = [];
  const deletedBundles: string[] = [];
  const bundleOutcomes = new Map<string, StorageGcOutcome>();
  const queuedBundles = new Map<string, StorageGcOutcome>();
  const calls: string[] = [];
  return {
    deletedRevisions,
    deletedBundles,
    bundleOutcomes,
    queuedBundles,
    calls,
    skills: {
      async listSkills() {
        return [skill({ activeRevisionId: 1 })];
      }
    },
    skillRevisions: {
      async listAllSkillRevisions() {
        return [];
      },
      async listActiveRuntimeSkillReferences() {
        return [];
      },
      async listAcceptedSubmissionRevisions() {
        return [];
      },
      async deleteSkillRevision(_t: string, _s: string, id: number) {
        calls.push(`delete:${id}`);
        deletedRevisions.push(id);
        return rev({ skillRevisionId: id, bundleStorageUri: `s3://bkt/sk1/v${id}` });
      }
    },
    bundleGc: {
      async retryTenantSkillBundles() {
        calls.push("retry");
        for (const [uri, outcome] of queuedBundles) if (outcome === "deleted") deletedBundles.push(uri);
        return new Map(queuedBundles);
      },
      async collectSkillBundle(row: { storageUri: string }) {
        calls.push(`collect:${row.storageUri}`);
        const outcome = bundleOutcomes.get(row.storageUri) ?? "deleted";
        if (outcome === "deleted") deletedBundles.push(row.storageUri);
        return outcome;
      }
    }
  };
}

test("cleanupInactiveSkillRevisions: dry-run reports candidate deletions without calling the delete path", async () => {
  const stores = captureStores();
  // Two old, non-active revisions of the SAME skill so the latest-protect rule
  // only retains rev 3.
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 1, revisionNumber: 1, bundleStorageUri: "s3://bkt/sk1/v1" }),
    rev({ skillRevisionId: 2, revisionNumber: 2, bundleStorageUri: "s3://bkt/sk1/v2" }),
    rev({ skillRevisionId: 3, revisionNumber: 3, bundleStorageUri: "s3://bkt/sk1/v3" })
  ];
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })]; // none active

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    bundleGc: stores.bundleGc,
    dryRun: true
  });
  expect(report.dryRun).toBe(true);
  // Latest (rev 3) is retained; rev 1 and rev 2 are flagged for deletion.
  expect(report.deletedRevisionIds.sort()).toEqual([1, 2]);
  // Bundles listed for tracking but no real deletion
  expect(stores.deletedRevisions.length).toBe(0);
  expect(stores.deletedBundles.length).toBe(0);
  // A dry run does not retry queued bundles either.
  expect(stores.calls).toEqual([]);
  expect(report.pendingBundleStorageUris).toEqual([]);
});

test("cleanupInactiveSkillRevisions: keeps the active revision", async () => {
  const stores = captureStores();
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 1, revisionNumber: 1 }),
    rev({ skillRevisionId: 2, revisionNumber: 2, bundleStorageUri: "s3://bkt/sk1/v2" })
  ];

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    bundleGc: stores.bundleGc,
    dryRun: false
  });
  expect(report.deletedRevisionIds).toEqual([]);
  expect(report.keptRevisionDecisions).toContainEqual({
    skillRevisionId: 1, reason: "active_registry_revision"
  });
  expect(stores.deletedRevisions).toEqual([]);
  expect(stores.deletedBundles).toEqual([]);
});

test("cleanupInactiveSkillRevisions: deletes inactive revision and removes bundle when last reference", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 5, revisionNumber: 1, bundleStorageUri: "s3://bkt/v5" }),
    rev({ skillRevisionId: 6, revisionNumber: 2, bundleStorageUri: "s3://bkt/v6" })
  ];

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    bundleGc: stores.bundleGc,
    dryRun: false
  });
  // rev 6 is latest, retained. rev 5 deleted.
  expect(stores.deletedRevisions).toEqual([5]);
  expect(stores.deletedBundles).toEqual(["s3://bkt/sk1/v5"]);
  expect(report.deletedRevisionIds).toEqual([5]);
});

test("cleanupInactiveSkillRevisions: keeps bundle when other revisions still reference it", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 5, revisionNumber: 1, bundleStorageUri: "s3://bkt/shared" }),
    rev({ skillRevisionId: 6, revisionNumber: 2, bundleStorageUri: "s3://bkt/v6" })
  ];
  // The collector finds the other revision that names the bundle.
  stores.bundleOutcomes.set("s3://bkt/sk1/v5", "retained");

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    bundleGc: stores.bundleGc,
    dryRun: false
  });
  expect(stores.deletedRevisions).toEqual([5]);
  // Bundle was NOT deleted (still referenced)
  expect(stores.deletedBundles).toEqual([]);
  expect(report.deletedBundleStorageUris).toEqual([]);
});

test("cleanupInactiveSkillRevisions: records failure when deletion returns null", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 5, revisionNumber: 1 }),
    rev({ skillRevisionId: 6, revisionNumber: 2 })
  ];
  stores.skillRevisions.deleteSkillRevision = async () => null;

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    bundleGc: stores.bundleGc,
    dryRun: false
  });
  expect(report.deletedRevisionIds).toEqual([]);
  expect(report.failures.length).toBe(1);
  expect(report.failures[0].reason).toMatch(/could not be deleted/);
});

test("cleanupInactiveSkillRevisions: catches and reports thrown errors", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 5, revisionNumber: 1 }),
    rev({ skillRevisionId: 6, revisionNumber: 2 })
  ];
  stores.skillRevisions.deleteSkillRevision = async () => {
    throw new Error("db locked");
  };

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    bundleGc: stores.bundleGc,
    dryRun: false
  });
  expect(report.failures.length).toBe(1);
  expect(report.failures[0].reason).toBe("db locked");
});

test("cleanupInactiveSkillRevisions: deletedBundleStorageUris are deduped and sorted", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  // Two skills. Each keeps its latest revision and loses its older one.
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillId: "sk1", skillRevisionId: 1, revisionNumber: 1, bundleStorageUri: "s3://bkt/b" }),
    rev({ skillId: "sk1", skillRevisionId: 11, revisionNumber: 2, bundleStorageUri: "s3://bkt/sk1-latest" }),
    rev({ skillId: "sk2", skillRevisionId: 2, revisionNumber: 1, bundleStorageUri: "s3://bkt/a" }),
    rev({ skillId: "sk2", skillRevisionId: 22, revisionNumber: 2, bundleStorageUri: "s3://bkt/sk2-latest" })
  ];
  stores.skillRevisions.deleteSkillRevision = async (_t, _s, id) =>
    rev({
      skillRevisionId: id,
      bundleStorageUri: id === 1 ? "s3://bkt/b" : "s3://bkt/a"
    });

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    bundleGc: stores.bundleGc,
    dryRun: false
  });
  expect(report.deletedBundleStorageUris).toEqual(["s3://bkt/a", "s3://bkt/b"]);
});


test("cleanupInactiveSkillRevisions keeps an old revision used only by a running runtime", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 2 })];
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 1, revisionNumber: 1 }),
    rev({ skillRevisionId: 2, revisionNumber: 2, bundleStorageUri: "s3://bkt/sk1/v2" })
  ];
  stores.skillRevisions.listActiveRuntimeSkillReferences = async () => [
    { sessionId: "running-session", skillId: "sk1", revisionId: 1, bundleHash: "h" }
  ];
  const report = await cleanupInactiveSkillRevisions({ tenantId: "t", config, ...stores, dryRun: false });
  expect(report.keptRevisionDecisions).toContainEqual({
    skillRevisionId: 1, reason: "active_runtime_reference:running-session"
  });
  expect(stores.deletedRevisions).toEqual([]);
  expect(stores.deletedBundles).toEqual([]);
});

test("cleanupInactiveSkillRevisions keeps a revision that an accepted submission names", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 1, revisionNumber: 1 }),
    rev({ skillRevisionId: 2, revisionNumber: 2, bundleStorageUri: null })
  ];
  stores.skillRevisions.listAcceptedSubmissionRevisions = async () => [
    { revisionId: 1, submissionId: "sub-b" },
    { revisionId: 1, submissionId: "sub-a" }
  ];

  const report = await cleanupInactiveSkillRevisions({ tenantId: "t", config, ...stores, dryRun: false });

  expect(report.keptRevisionDecisions).toContainEqual({
    skillRevisionId: 1, reason: "accepted_submission_reference:sub-b,sub-a"
  });
  expect(report.deletedRevisionIds).toEqual([]);
  expect(stores.deletedRevisions).toEqual([]);
});

test("cleanupInactiveSkillRevisions reports a failed bundle delete as pending, not as a failed revision", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 5, revisionNumber: 1 }),
    rev({ skillRevisionId: 6, revisionNumber: 2 })
  ];
  stores.bundleOutcomes.set("s3://bkt/sk1/v5", "pending");

  const report = await cleanupInactiveSkillRevisions({ tenantId: "t", config, ...stores, dryRun: false });

  expect(report.deletedRevisionIds).toEqual([5]);
  expect(report.deletedBundleStorageUris).toEqual([]);
  expect(report.pendingBundleStorageUris).toEqual(["s3://bkt/sk1/v5"]);
  expect(report.failures).toEqual([]);
});

test("cleanupInactiveSkillRevisions retries the queued bundles before it deletes new revisions", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 5, revisionNumber: 1 }),
    rev({ skillRevisionId: 6, revisionNumber: 2 })
  ];
  stores.queuedBundles.set("s3://bkt/earlier", "deleted");
  stores.queuedBundles.set("s3://bkt/still-failing", "pending");

  const report = await cleanupInactiveSkillRevisions({ tenantId: "t", config, ...stores, dryRun: false });

  expect(stores.calls).toEqual(["retry", "delete:5", "collect:s3://bkt/sk1/v5"]);
  expect(report.deletedBundleStorageUris).toEqual(["s3://bkt/earlier", "s3://bkt/sk1/v5"]);
  expect(report.pendingBundleStorageUris).toEqual(["s3://bkt/still-failing"]);
});
