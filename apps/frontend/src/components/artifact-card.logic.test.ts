import type { Artifact } from "@cogniplane/shared-types";
import { describe, expect, it } from "vitest";

import { artifactCardPreviewBlock, findSessionArtifact } from "./artifact-card.logic";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: "a-1",
    sessionId: "s-1",
    artifactName: "report.csv",
    mimeType: "text/csv",
    fileSizeBytes: 2048,
    status: "ready",
    detail: {},
    ...overrides
  } as Artifact;
}

describe("findSessionArtifact", () => {
  it("finds the artifact only in the given session, also in a mixed or stale list", () => {
    const own = artifact();
    const other = artifact({ artifactId: "a-2", sessionId: "s-2" });
    const list = [other, own];

    expect(findSessionArtifact(list, "s-1", "a-1")).toBe(own);
    expect(findSessionArtifact(list, "s-1", "a-2")).toBeNull();
    expect(findSessionArtifact(list, "s-2", "a-1")).toBeNull();
    expect(findSessionArtifact(list, "s-1", "unknown")).toBeNull();
    expect(findSessionArtifact([], "s-1", "a-1")).toBeNull();
  });
});

describe("artifactCardPreviewBlock", () => {
  it("lets a ready, previewable file with a clean or finished scan open", () => {
    expect(artifactCardPreviewBlock(artifact())).toBeNull();
    expect(artifactCardPreviewBlock(artifact({ detail: { pii: { status: "scanned", findingsCount: 0 } } }))).toBeNull();
    expect(artifactCardPreviewBlock(artifact({ detail: { pii: { status: "transformed" } } }))).toBeNull();
    expect(artifactCardPreviewBlock(artifact({ mimeType: "image/png" }))).toBeNull();
  });

  it.each(["pending", "processing", "failed", "deleted"] as const)("blocks a %s file", (status) => {
    expect(artifactCardPreviewBlock(artifact({ status }))).toEqual(expect.any(String));
  });

  it.each(["pending", "scanning", "blocked"] as const)("blocks a ready file while its PII scan is %s", (status) => {
    expect(artifactCardPreviewBlock(artifact({ detail: { pii: { status } } }))).toMatch(/PII policy/);
  });

  it("blocks a ready file whose PII scan failed, as the preview route does", () => {
    expect(artifactCardPreviewBlock(artifact({ detail: { pii: { status: "failed" } } }))).toMatch(/PII scan of this file failed/);
  });

  it("blocks a ready file with a PII verdict it does not know", () => {
    expect(artifactCardPreviewBlock(artifact({ detail: { pii: { status: "quarantined" as never } } }))).toMatch(/PII policy/);
  });

  it("blocks a type that the preview does not show", () => {
    expect(artifactCardPreviewBlock(artifact({ mimeType: "application/zip" }))).toMatch(/file type/);
    expect(artifactCardPreviewBlock(artifact({ mimeType: "image/svg+xml" }))).toMatch(/file type/);
  });
});
