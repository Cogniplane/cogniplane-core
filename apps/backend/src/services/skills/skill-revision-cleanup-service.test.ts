import { test, expect } from "vitest";

import type { AdminSkillRecord, AdminSkillRevisionRecord } from "../admin-config-records.js";

import { cleanupInactiveSkillRevisions } from "./skill-revision-cleanup-service.js";

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
    tenantId: "t",
    skillName: "Skill",
    description: null,
    bundleRootPath: null,
    activeRevisionId: 1,
    createdAt: "now",
    updatedAt: "now",
    enabled: true,
    ...(o as never)
  };
}

const config = {
  SKILL_BUNDLE_RETENTION_DAYS: 30
} as never;

function captureStores() {
  const deletedRevisions: number[] = [];
  const deletedBundles: string[] = [];
  return {
    deletedRevisions,
    deletedBundles,
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
      async deleteSkillRevision(_t: string, _s: string, id: number) {
        deletedRevisions.push(id);
        return rev({ skillRevisionId: id, bundleStorageUri: `s3://bkt/sk1/v${id}` });
      },
      async countSkillRevisionsByBundleStorageUri() {
        return 0;
      }
    },
    skillBundleStorage: {
      async deleteBundle(uri: string) {
        deletedBundles.push(uri);
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
    skillBundleStorage: stores.skillBundleStorage,
    dryRun: true
  });
  expect(report.dryRun).toBe(true);
  // Latest (rev 3) is retained; rev 1 and rev 2 are flagged for deletion.
  expect(report.deletedRevisionIds.sort()).toEqual([1, 2]);
  // Bundles listed for tracking but no real deletion
  expect(stores.deletedRevisions.length).toBe(0);
  expect(stores.deletedBundles.length).toBe(0);
});

test("cleanupInactiveSkillRevisions: keeps the active revision", async () => {
  const stores = captureStores();
  stores.skillRevisions.listAllSkillRevisions = async () => [
    rev({ skillRevisionId: 1 }) // matches activeRevisionId=1
  ];

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    skillBundleStorage: stores.skillBundleStorage,
    dryRun: false
  });
  expect(report.deletedRevisionIds).toEqual([]);
  expect(report.keptRevisionDecisions.length).toBe(1);
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
    skillBundleStorage: stores.skillBundleStorage,
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
  stores.skillRevisions.countSkillRevisionsByBundleStorageUri = async () => 2;

  const report = await cleanupInactiveSkillRevisions({
    tenantId: "t",
    config,
    skills: stores.skills,
    skillRevisions: stores.skillRevisions,
    skillBundleStorage: stores.skillBundleStorage,
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
    skillBundleStorage: stores.skillBundleStorage,
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
    skillBundleStorage: stores.skillBundleStorage,
    dryRun: false
  });
  expect(report.failures.length).toBe(1);
  expect(report.failures[0].reason).toBe("db locked");
});

test("cleanupInactiveSkillRevisions: deletedBundleStorageUris are deduped and sorted", async () => {
  const stores = captureStores();
  stores.skills.listSkills = async () => [skill({ activeRevisionId: 99 })];
  // Use distinct skillIds so all four are non-latest candidates.
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
    skillBundleStorage: stores.skillBundleStorage,
    dryRun: false
  });
  expect(report.deletedBundleStorageUris).toEqual(["s3://bkt/a", "s3://bkt/b"]);
});
