import { test, expect } from "vitest";

import {
  isArtifactEligibleForChatContext,
  isPiiHoldingArtifact
} from "./artifact-eligibility.js";
import {
  ARTIFACT_PII_ELIGIBLE_STATUSES,
  isArtifactPiiEligible,
  type Artifact,
  type ArtifactPiiDetail
} from "@cogniplane/shared-types";

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: "art-1",
    sessionId: "sess-1",
    userId: "user-1",
    artifactType: "upload",
    sourceArtifactId: null,
    artifactName: "report.pdf",
    mimeType: "application/pdf",
    storageBackend: "local",
    storageKey: "key",
    fileSizeBytes: 1024,
    checksumSha256: "abc",
    status: "ready",
    createdByType: "user",
    createdByRef: null,
    detail: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

const ARTIFACT_STATUSES = ["pending", "processing", "ready", "failed", "deleted"] as const;
const PII_STATUSES = ["pending", "scanning", "scanned", "blocked", "transformed", "failed"] as const;

test("the eligible verdicts are the backend allow-list: scanned and transformed", () => {
  expect([...ARTIFACT_PII_ELIGIBLE_STATUSES].sort()).toEqual(["scanned", "transformed"]);
});

test("isArtifactEligibleForChatContext answers every (status, PII status) pair as the backend does", () => {
  for (const status of ARTIFACT_STATUSES) {
    for (const pii of [undefined, ...PII_STATUSES]) {
      const artifact = makeArtifact({ status, detail: pii ? { pii: { status: pii } } : {} });
      const expected = status === "ready" && (pii === undefined || pii === "scanned" || pii === "transformed");
      expect(isArtifactEligibleForChatContext(artifact), `${status} / ${String(pii)}`).toBe(expected);
      expect(isArtifactEligibleForChatContext(artifact)).toBe(isArtifactPiiEligible(artifact));
    }
  }
});

test("isArtifactEligibleForChatContext refuses a ready file with a failed scan", () => {
  expect(isArtifactEligibleForChatContext(makeArtifact({ detail: { pii: { status: "failed" } } }))).toBe(false);
});

test("isArtifactEligibleForChatContext refuses a PII verdict it does not know", () => {
  const artifact = makeArtifact({ detail: { pii: { status: "quarantined" as never } } });
  expect(isArtifactEligibleForChatContext(artifact)).toBe(false);
});

test("isArtifactEligibleForChatContext accepts a ready file with no verdict", () => {
  expect(isArtifactEligibleForChatContext(makeArtifact())).toBe(true);
  expect(isArtifactEligibleForChatContext(makeArtifact({ detail: { pii: {} } }))).toBe(true);
});

test("isPiiHoldingArtifact holds every verdict except none, scanned and transformed", () => {
  expect(isPiiHoldingArtifact(undefined)).toBe(false);
  expect(isPiiHoldingArtifact({} as ArtifactPiiDetail)).toBe(false);
  expect(isPiiHoldingArtifact({ status: "scanned" })).toBe(false);
  expect(isPiiHoldingArtifact({ status: "transformed" })).toBe(false);
  for (const status of ["pending", "scanning", "blocked", "failed"] as const) {
    expect(isPiiHoldingArtifact({ status }), status).toBe(true);
  }
});
