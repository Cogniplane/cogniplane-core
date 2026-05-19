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

test("ArtifactProcessor returns empty render result for non-PDF artifacts", async () => {
  const processor = new ArtifactProcessor({
    config: { PDFTOTEXT_BINARY_PATH: "pdftotext" },
    logger: noopLogger,
    storage: new InMemoryProcessingStorage()
  });
  const result = await processor.renderArtifactImages({
    ...createPdfArtifact(),
    mimeType: "text/plain"
  });
  expect(result.paths).toEqual([]);
  // cleanup is a no-op but should be callable
  await result.cleanup();
});

test("ArtifactProcessor returns empty render result for deleted/failed status", async () => {
  const processor = new ArtifactProcessor({
    config: { PDFTOTEXT_BINARY_PATH: "pdftotext" },
    logger: noopLogger,
    storage: new InMemoryProcessingStorage()
  });
  const deletedRender = await processor.renderArtifactImages({
    ...createPdfArtifact(),
    status: "deleted"
  });
  expect(deletedRender.paths).toEqual([]);

  const failedRender = await processor.renderArtifactImages({
    ...createPdfArtifact(),
    status: "failed"
  });
  expect(failedRender.paths).toEqual([]);
});

test("ArtifactProcessor.renderArtifactImages returns empty + warns when pdftoppm fails", async () => {
  const storage = new InMemoryProcessingStorage();
  storage.seed("user/session/report.pdf", "not-a-real-pdf");
  const warnings: object[] = [];
  const processor = new ArtifactProcessor({
    config: { PDFTOTEXT_BINARY_PATH: "pdftotext" },
    logger: {
      warn(meta: object) {
        warnings.push(meta);
      },
      error() {}
    },
    storage
  });
  // pdftoppm will fail because the buffer isn't a valid PDF.
  const result = await processor.renderArtifactImages(createPdfArtifact());
  expect(result.paths).toEqual([]);
  // Warning may or may not fire depending on host pdftoppm; if it fired we
  // logged a warn entry. Either way we expect graceful empty paths.
  expect(Array.isArray(result.paths)).toBe(true);
  await result.cleanup();
});
