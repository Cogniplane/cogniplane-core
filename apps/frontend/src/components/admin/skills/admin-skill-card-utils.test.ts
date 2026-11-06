import { expect, it } from "vitest";
import type { AdminSkill, SkillRevision } from "@cogniplane/shared-types";

import { describeRevisionSource, describeSkillUsage, getRevisionGithubMetadata } from "./admin-skill-card-utils";

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

it("describes actual source types without assuming GitHub visibility", () => {
  expect(describeRevisionSource({ ...revision({}), sourceType: "github" })).toBe("GitHub import");
  expect(describeRevisionSource({ ...revision({}), sourceType: "zip" })).toBe("ZIP upload");
  expect(describeRevisionSource({ ...revision({}), sourceType: "inline" })).toBe("Inline SKILL.md");
  expect(describeRevisionSource({ ...revision({}), sourceType: "inline", metadata: { organizationSubmissionId: "submission-a" } })).toBe("Inline member submission");
});

it("keeps unknown usage separate from explicit zero and each 30-day measure", () => {
  expect(describeSkillUsage({} as AdminSkill)).toBe("Used sessions unavailable; offered sessions unavailable. Period: last 30 days.");
  expect(describeSkillUsage({ invokedSessions30d: 0, materializedSessions30d: 24 } as AdminSkill)).toBe("Used in 0 sessions; offered in 24 sessions. Period: last 30 days.");
  expect(describeSkillUsage({ materializedSessions30d: 0 } as AdminSkill)).toBe("Used sessions unavailable; offered in 0 sessions. Period: last 30 days.");
});
