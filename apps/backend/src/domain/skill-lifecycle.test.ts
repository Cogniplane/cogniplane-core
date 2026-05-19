import { test, expect } from "vitest";

import {
  canActivateRevision,
  isBundleBackedSkill
} from "./skill-lifecycle.js";
import { getCleanupDecision, getLatestRevisionIds } from "./skill-cleanup-policy.js";

test("canActivateRevision allows supported validation states", () => {
  expect(canActivateRevision("validated")).toBe(true);
  expect(canActivateRevision("validated_with_warnings")).toBe(true);
  expect(canActivateRevision("rejected")).toBe(false);
});

test("isBundleBackedSkill distinguishes configured and missing sources", () => {
  expect(isBundleBackedSkill({ sourceType: "github" })).toBe(true);
  expect(isBundleBackedSkill({ sourceType: "zip" })).toBe(true);
  expect(isBundleBackedSkill({ sourceType: null })).toBe(false);
});

test("getLatestRevisionIds returns the newest revision per skill", () => {
  const latest = getLatestRevisionIds([
    {
      skillRevisionId: 1,
      skillId: "pdf-processing",
      revisionNumber: 1,
      sourceType: "zip",
      sourceLabel: "one",
      bundleName: "pdf-processing",
      bundleStorageUri: "file:///tmp/one",
      bundleHash: "hash-1",
      validationStatus: "validated",
      validationMessages: [],
      reviewStatus: "approved",
      reviewNotes: null,
      metadata: {},
      createdBy: "admin-user",
      createdAt: "2026-03-01T00:00:00.000Z",
      reviewedBy: null,
      reviewedAt: null,
      activatedAt: null
    },
    {
      skillRevisionId: 2,
      skillId: "pdf-processing",
      revisionNumber: 2,
      sourceType: "zip",
      sourceLabel: "two",
      bundleName: "pdf-processing",
      bundleStorageUri: "file:///tmp/two",
      bundleHash: "hash-2",
      validationStatus: "validated",
      validationMessages: [],
      reviewStatus: "active",
      reviewNotes: null,
      metadata: {},
      createdBy: "admin-user",
      createdAt: "2026-03-02T00:00:00.000Z",
      reviewedBy: null,
      reviewedAt: null,
      activatedAt: null
    }
  ]);

  expect([...latest]).toEqual([2]);
});

test("getCleanupDecision retains active and recent revisions and deletes stale ones", () => {
  const recentRevision = {
    skillRevisionId: 5,
    skillId: "pdf-processing",
    revisionNumber: 5,
    sourceType: "github",
    sourceLabel: "repo@main",
    bundleName: "pdf-processing",
    bundleStorageUri: "file:///tmp/active",
    bundleHash: "hash-active",
    validationStatus: "validated",
    validationMessages: [],
    reviewStatus: "approved",
    reviewNotes: null,
    metadata: {},
    createdBy: "admin-user",
    createdAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    activatedAt: null
  };

  const recentDecision = getCleanupDecision({
    revision: recentRevision,
    activeRevisionIds: new Set<number>(),
    activeRuntimeReferences: [],
    activeRuntimeRevisionIds: new Set<number>(),
    latestRevisionIds: new Set<number>(),
    retentionCutoff: Date.now() - 24 * 60 * 60 * 1000
  });
  expect(recentDecision.retain).toBe(true);
  expect(recentDecision.reason).toBe("within_retention_window");

  const staleDecision = getCleanupDecision({
    revision: {
      ...recentRevision,
      skillRevisionId: 1,
      createdAt: "2020-01-01T00:00:00.000Z"
    },
    activeRevisionIds: new Set<number>(),
    activeRuntimeReferences: [],
    activeRuntimeRevisionIds: new Set<number>(),
    latestRevisionIds: new Set<number>(),
    retentionCutoff: Date.now() - 24 * 60 * 60 * 1000
  });
  expect(staleDecision.retain).toBe(false);
  expect(staleDecision.reason).toBe(null);
});
