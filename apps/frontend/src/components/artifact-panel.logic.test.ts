import { describe, expect, test } from "vitest";
import type { Artifact, ArtifactPiiDetail } from "@cogniplane/shared-types";

import {
  canDownloadArtifact,
  formatArtifactStatus,
  formatFileSize,
  formatPiiLabel,
  getArtifactOrigin,
  piiTone
} from "./artifact-panel.logic";

function makeArtifact(overrides: Partial<Artifact>): Artifact {
  return {
    artifactId: "a",
    artifactName: "doc.pdf",
    fileSizeBytes: 1024,
    mimeType: "application/pdf",
    status: "ready",
    artifactType: "upload",
    createdByType: "user",
    createdAt: new Date().toISOString(),
    ...overrides
  } as Artifact;
}

describe("formatFileSize", () => {
  test("bytes / KB / MB scales", () => {
    expect(formatFileSize(500)).toBe("500 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(2_500_000)).toBe("2.4 MB");
  });
});

describe("formatArtifactStatus", () => {
  test("known states", () => {
    expect(formatArtifactStatus("ready")).toBe("Ready");
    expect(formatArtifactStatus("processing")).toBe("Processing");
    expect(formatArtifactStatus("failed")).toBe("Failed");
    expect(formatArtifactStatus("deleted")).toBe("Deleted");
  });

  test("unknown falls back to Pending", () => {
    expect(formatArtifactStatus("pending" as Artifact["status"])).toBe("Pending");
  });
});

describe("formatPiiLabel", () => {
  function p(overrides: Partial<ArtifactPiiDetail>): ArtifactPiiDetail {
    return { status: "pending", ...overrides } as ArtifactPiiDetail;
  }

  test("scanning states", () => {
    expect(formatPiiLabel(p({ status: "pending" }))).toContain("Scanning");
    expect(formatPiiLabel(p({ status: "scanning" }))).toContain("Scanning");
  });

  test("blocked uses the reason when present", () => {
    expect(formatPiiLabel(p({ status: "blocked", blockReason: "SSN detected" })))
      .toBe("Blocked: SSN detected");
    expect(formatPiiLabel(p({ status: "blocked" }))).toBe("Blocked by PII policy");
  });

  test("scanned reports findings count or clean", () => {
    expect(formatPiiLabel(p({ status: "scanned", findingsCount: 0 }))).toBe("PII: clean");
    expect(formatPiiLabel(p({ status: "scanned", findingsCount: 1 }))).toBe("PII: 1 finding");
    expect(formatPiiLabel(p({ status: "scanned", findingsCount: 3 }))).toBe("PII: 3 findings");
  });

  test("transformed has its own label", () => {
    expect(formatPiiLabel(p({ status: "transformed" }))).toBe("PII redacted");
  });
});

describe("piiTone", () => {
  test("each status maps to a tone", () => {
    expect(piiTone({ status: "scanning" } as ArtifactPiiDetail)).toBe("pending");
    expect(piiTone({ status: "blocked" } as ArtifactPiiDetail)).toBe("blocked");
    expect(piiTone({ status: "failed" } as ArtifactPiiDetail)).toBe("failed");
    expect(piiTone({ status: "transformed" } as ArtifactPiiDetail)).toBe("transformed");
    expect(piiTone({ status: "scanned" } as ArtifactPiiDetail)).toBe("neutral");
  });
});

describe("canDownloadArtifact", () => {
  test("uploads are downloadable in any non-deleted state", () => {
    expect(canDownloadArtifact(makeArtifact({ artifactType: "upload", status: "processing" }))).toBe(true);
  });

  test("generated artifacts only when ready", () => {
    expect(canDownloadArtifact(makeArtifact({ artifactType: "generated", status: "processing" }))).toBe(false);
    expect(canDownloadArtifact(makeArtifact({ artifactType: "generated", status: "ready" }))).toBe(true);
  });

  test("deleted artifacts can never download", () => {
    expect(canDownloadArtifact(makeArtifact({ status: "deleted" }))).toBe(false);
  });
});

describe("getArtifactOrigin", () => {
  test("microsoft sources tagged accordingly", () => {
    expect(getArtifactOrigin(makeArtifact({
      detail: { source: "microsoft" },
      createdByType: "user"
    } as unknown as Partial<Artifact>))).toBe("Microsoft import");
    expect(getArtifactOrigin(makeArtifact({
      detail: { source: "microsoft" },
      createdByType: "tool"
    } as unknown as Partial<Artifact>))).toBe("Added by assistant");
  });

  test("tool-created artifacts always read 'Added by assistant'", () => {
    expect(getArtifactOrigin(makeArtifact({ createdByType: "tool" }))).toBe("Added by assistant");
  });

  test("artifact type drives the rest of the labels", () => {
    expect(getArtifactOrigin(makeArtifact({ artifactType: "generated" }))).toBe("Generated");
    expect(getArtifactOrigin(makeArtifact({ artifactType: "derived" }))).toBe("Derived");
    expect(getArtifactOrigin(makeArtifact({ artifactType: "upload" }))).toBe("Uploaded");
  });
});
