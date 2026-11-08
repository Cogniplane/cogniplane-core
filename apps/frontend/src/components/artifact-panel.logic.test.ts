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
import { registerArtifactOrigin } from "../lib/artifact-origins";

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

  test("a scan that applied mode off says that it did not scan, not that the file is clean", () => {
    expect(formatPiiLabel(p({ status: "scanned", modeApplied: "off", findingsCount: 0 }))).toBe("PII: not scanned");
    expect(formatPiiLabel(p({ status: "scanned", modeApplied: "off", findingsCount: 0, imagesNotScanned: true })))
      .toBe("PII: not scanned");
    expect(formatPiiLabel(p({ status: "scanned", modeApplied: "detect", findingsCount: 0 }))).toBe("PII: clean");
    expect(piiTone(p({ status: "scanned", modeApplied: "off" }))).toBe("neutral");
  });

  test("a verdict on text only says so", () => {
    expect(formatPiiLabel(p({ status: "scanned", findingsCount: 0, imagesNotScanned: true })))
      .toBe("PII: clean (text only)");
    expect(formatPiiLabel(p({ status: "transformed", imagesNotScanned: true })))
      .toBe("PII redacted (text only)");
    expect(formatPiiLabel(p({ status: "failed", imagesNotScanned: true }))).toBe("PII scan failed");
  });

  test("a verdict on a PDF says how much of its page images OCR read", () => {
    expect(formatPiiLabel(p({ status: "scanned", findingsCount: 0, imageScan: "complete", imagePagesScanned: 3, imagePageCount: 3 })))
      .toBe("PII: clean");
    expect(formatPiiLabel(p({ status: "scanned", findingsCount: 2, imagesNotScanned: true, imageScan: "partial", imagePagesScanned: 20, imagePageCount: 40 })))
      .toBe("PII: 2 findings (images partly scanned)");
    expect(formatPiiLabel(p({ status: "transformed", imagesNotScanned: true, imageScan: "failed", imagePagesScanned: 0 })))
      .toBe("PII redacted (image scan failed)");
    expect(formatPiiLabel(p({ status: "blocked", blockReason: "email", imageScan: "partial" }))).toBe("Blocked: email");
    expect(formatPiiLabel(p({ status: "scanned", modeApplied: "off", findingsCount: 0, imageScan: "failed" }))).toBe("PII: not scanned");
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
    expect(piiTone({ status: "scanned" } as ArtifactPiiDetail)).toBe("clean");
  });

  test("only a real scan with no findings is clean; findings and skipped scans are not", () => {
    const p = (overrides: Partial<ArtifactPiiDetail>) => overrides as ArtifactPiiDetail;
    expect(piiTone(p({ status: "scanned", modeApplied: "detect", findingsCount: 0 }))).toBe("clean");
    expect(piiTone(p({ status: "scanned", modeApplied: "detect", findingsCount: 0, imagesNotScanned: true }))).toBe("clean");
    expect(piiTone(p({ status: "scanned", modeApplied: "detect", findingsCount: 7 }))).toBe("findings");
    expect(piiTone(p({ status: "scanned", findingsCount: 2, imagesNotScanned: true }))).toBe("findings");
    expect(piiTone(p({ status: "scanned", modeApplied: "off", findingsCount: 0 }))).toBe("neutral");
  });
});

describe("canDownloadArtifact", () => {
  test("uploads only when their PII scan has made them ready", () => {
    expect(canDownloadArtifact(makeArtifact({ artifactType: "upload", status: "pending" }))).toBe(false);
    expect(canDownloadArtifact(makeArtifact({ artifactType: "upload", status: "failed" }))).toBe(false);
    expect(canDownloadArtifact(makeArtifact({ artifactType: "upload", status: "ready" }))).toBe(true);
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
  // Runs before the registration below: core alone names no import origin.
  test("an unregistered detail source gets the core labels", () => {
    expect(getArtifactOrigin(makeArtifact({
      detail: { source: "microsoft" },
      createdByType: "user"
    } as unknown as Partial<Artifact>))).toEqual({ label: "Uploaded", tone: "neutral" });
  });

  test("a registered origin gives its label and tone", () => {
    registerArtifactOrigin({ detailSource: "example-drive", label: "Example import", tone: "accent" });
    expect(getArtifactOrigin(makeArtifact({
      detail: { source: "example-drive" },
      createdByType: "user"
    } as unknown as Partial<Artifact>))).toEqual({ label: "Example import", tone: "accent" });
    expect(getArtifactOrigin(makeArtifact({
      detail: { source: "example-drive" },
      createdByType: "tool"
    } as unknown as Partial<Artifact>))).toEqual({ label: "Added by assistant", tone: "accent" });
  });

  test("the first registration of a detail source wins", () => {
    registerArtifactOrigin({ detailSource: "example-drive", label: "Other label", tone: "neutral" });
    expect(getArtifactOrigin(makeArtifact({
      detail: { source: "example-drive" }
    } as unknown as Partial<Artifact>))).toEqual({ label: "Example import", tone: "accent" });
  });

  test("tool-created artifacts always read 'Added by assistant'", () => {
    expect(getArtifactOrigin(makeArtifact({ createdByType: "tool" }))).toEqual({ label: "Added by assistant", tone: "neutral" });
  });

  test("artifact type drives the rest of the labels", () => {
    expect(getArtifactOrigin(makeArtifact({ artifactType: "generated" })).label).toBe("Generated");
    expect(getArtifactOrigin(makeArtifact({ artifactType: "derived" })).label).toBe("Derived");
    expect(getArtifactOrigin(makeArtifact({ artifactType: "upload" })).label).toBe("Uploaded");
  });
});
