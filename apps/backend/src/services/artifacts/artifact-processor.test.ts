import { Readable } from "node:stream";
import { test, expect } from "vitest";

import type { ArtifactRecord } from "./artifact-store.js";

import { ArtifactProcessor } from "./artifact-processor.js";

class InMemoryProcessingStorage {
  private readonly files = new Map<string, Buffer>();

  seed(storageKey: string, content: string): void {
    this.files.set(storageKey, Buffer.from(content, "utf8"));
  }

  async openReadStream(storageKey: string) {
    const file = this.files.get(storageKey);
    if (!file) {
      throw new Error("Missing file");
    }

    return {
      stream: Readable.from([file]),
      fileSizeBytes: file.length
    };
  }
}

const noopLogger = {
  warn() {},
  error() {}
};

function createPdfArtifact(): ArtifactRecord {
  return {
    id: 1,
    artifactId: "source-artifact",
    sessionId: "session-1",
    userId: "user-1",
    artifactType: "upload",
    sourceArtifactId: null,
    artifactName: "report.pdf",
    mimeType: "application/pdf",
    storageBackend: "local",
    storageKey: "user/session/report.pdf",
    fileSizeBytes: 10,
    checksumSha256: "source",
    status: "ready",
    createdByType: "user",
    createdByRef: null,
    detail: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

test("ArtifactProcessor extracts PDF text on demand", async () => {
  const storage = new InMemoryProcessingStorage();
  storage.seed("user/session/report.pdf", "pdf-binary-placeholder");
  const processor = new ArtifactProcessor({
    config: {
      PDFTOTEXT_BINARY_PATH: "pdftotext"
    },
    logger: noopLogger,
    storage,
    extractPdfText: async () => "Extracted PDF text"
  });

  const extracted = await processor.extractArtifactText(createPdfArtifact());
  expect(extracted).toBe("Extracted PDF text");
});

test("ArtifactProcessor skips non-PDF artifacts for on-demand extraction", async () => {
  const processor = new ArtifactProcessor({
    config: {
      PDFTOTEXT_BINARY_PATH: "pdftotext"
    },
    logger: noopLogger,
    storage: new InMemoryProcessingStorage()
  });
  const extracted = await processor.extractArtifactText({
    ...createPdfArtifact(),
    mimeType: "text/plain",
    artifactName: "notes.txt"
  });
  expect(extracted).toBe(null);
});

test("ArtifactProcessor returns null when the artifact is in 'deleted' status", async () => {
  const processor = new ArtifactProcessor({
    config: { PDFTOTEXT_BINARY_PATH: "pdftotext" },
    logger: noopLogger,
    storage: new InMemoryProcessingStorage()
  });
  const result = await processor.extractArtifactText({
    ...createPdfArtifact(),
    status: "deleted"
  });
  expect(result).toBeNull();
});

test("ArtifactProcessor returns null when the artifact is in 'failed' status", async () => {
  const processor = new ArtifactProcessor({
    config: { PDFTOTEXT_BINARY_PATH: "pdftotext" },
    logger: noopLogger,
    storage: new InMemoryProcessingStorage()
  });
  const result = await processor.extractArtifactText({
    ...createPdfArtifact(),
    status: "failed"
  });
  expect(result).toBeNull();
});
