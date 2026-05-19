import { test, expect } from "vitest";

import {
  isArtifactEligibleForChatContext,
  isPiiBlockingContext
} from "./artifact-eligibility.js";
import type { Artifact, ArtifactPiiDetail } from "@cogniplane/shared-types";

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

test("isPiiBlockingContext returns false when pii is undefined", () => {
  expect(isPiiBlockingContext(undefined)).toBe(false);
});

test("isPiiBlockingContext returns false when pii.status is missing", () => {
  expect(isPiiBlockingContext({} as ArtifactPiiDetail)).toBe(false);
});

test("isPiiBlockingContext blocks pending, scanning, blocked", () => {
  expect(isPiiBlockingContext({ status: "pending" })).toBe(true);
  expect(isPiiBlockingContext({ status: "scanning" })).toBe(true);
  expect(isPiiBlockingContext({ status: "blocked" })).toBe(true);
});

test("isPiiBlockingContext does NOT block failed (transient outage)", () => {
  expect(isPiiBlockingContext({ status: "failed" })).toBe(false);
});

test("isPiiBlockingContext does NOT block scanned or transformed", () => {
  expect(isPiiBlockingContext({ status: "scanned" })).toBe(false);
  expect(isPiiBlockingContext({ status: "transformed" })).toBe(false);
});

test("isArtifactEligibleForChatContext rejects non-ready artifacts", () => {
  for (const status of ["pending", "processing", "failed", "deleted"] as const) {
    expect(isArtifactEligibleForChatContext(makeArtifact({ status }))).toBe(false);
  }
});

test("isArtifactEligibleForChatContext accepts ready + no pii", () => {
  expect(isArtifactEligibleForChatContext(makeArtifact())).toBe(true);
});

test("isArtifactEligibleForChatContext rejects ready + blocking pii", () => {
  const artifact = makeArtifact({
    detail: { pii: { status: "blocked" } }
  });
  expect(isArtifactEligibleForChatContext(artifact)).toBe(false);
});

test("isArtifactEligibleForChatContext accepts ready + failed pii (transient)", () => {
  const artifact = makeArtifact({
    detail: { pii: { status: "failed" } }
  });
  expect(isArtifactEligibleForChatContext(artifact)).toBe(true);
});
