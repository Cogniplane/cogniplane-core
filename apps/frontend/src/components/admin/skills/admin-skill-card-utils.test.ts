import { expect, it } from "vitest";
import type { SkillRevision } from "@cogniplane/shared-types";

import { getRevisionGithubMetadata } from "./admin-skill-card-utils";

function revision(metadata: Record<string, unknown>): SkillRevision {
  return {
    skillRevisionId: 1, skillId: "pdf", revisionNumber: 1, sourceType: "github", sourceLabel: null,
    bundleName: null, bundleStorageUri: null, bundleHash: "h", validationStatus: "valid", validationMessages: [],
    reviewStatus: "active", reviewNotes: null, metadata, createdBy: "u1", createdAt: "2026-10-01T00:00:00.000Z",
    reviewedBy: null, reviewedAt: null, activatedAt: null
  };
}

it.each([
  [{ url: "https://github.com/o/r" }],
  [{ url: "https://github.com/o/r", ref: "main", subdirectory: "skills/pdf" }],
  [{ url: "https://github.com/o/r", subdirectory: null }]
])("reads valid GitHub metadata: %j", (github) => {
  expect(getRevisionGithubMetadata(revision({ github }))).toEqual(github);
});

it.each([
  ["no github key", {}],
  ["a null value", { github: null }],
  ["a string", { github: "https://github.com/o/r" }],
  ["no url", { github: { ref: "main" } }],
  ["a non-string url", { github: { url: 42 } }],
  ["a non-string ref", { github: { url: "https://github.com/o/r", ref: 3 } }],
  ["a non-string subdirectory", { github: { url: "https://github.com/o/r", subdirectory: ["pdf"] } }]
])("ignores GitHub metadata with %s", (_case, metadata) => {
  expect(getRevisionGithubMetadata(revision(metadata))).toBeNull();
});
