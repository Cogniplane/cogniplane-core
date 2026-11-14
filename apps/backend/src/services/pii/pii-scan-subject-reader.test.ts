import { Readable } from "node:stream";

import { test, expect, vi } from "vitest";

import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactRecord, ArtifactStore } from "../artifacts/artifact-store.js";
import type { Pool } from "../../lib/db.js";
import type { PdfOcr } from "./pdf-ocr.js";
import { PiiProtectionServiceError } from "./pii-protection-service.js";
import { DatabasePiiScanSubjectReader } from "./pii-scan-subject-reader.js";

function buildReader(opts: {
  artifact: Partial<ArtifactRecord> | null;
  body: Buffer | Buffer[];
  maxBytes?: number;
  onDestroy?: () => void;
  ocrPdf?: PdfOcr;
}): DatabasePiiScanSubjectReader {
  const artifacts: Pick<ArtifactStore, "get"> = {
    get: async () =>
      opts.artifact === null
        ? null
        : ({
            artifactId: "art_1",
            mimeType: "text/plain",
            storageKey: "key_1",
            ...opts.artifact
          } as ArtifactRecord)
  };
  const storage: Pick<ArtifactStorage, "openReadStream"> = {
    openReadStream: async () => {
      const chunks = Array.isArray(opts.body) ? opts.body : [opts.body];
      const stream = Readable.from(chunks);
      if (opts.onDestroy) {
        const realDestroy = stream.destroy.bind(stream);
        stream.destroy = ((...args: unknown[]) => {
          opts.onDestroy!();
          return realDestroy(...(args as []));
        }) as typeof stream.destroy;
      }
      return { stream, fileSizeBytes: chunks.reduce((total, chunk) => total + chunk.length, 0) };
    }
  };
  return new DatabasePiiScanSubjectReader({
    db: {} as Pool,
    artifacts,
    storage,
    maxBytes: opts.maxBytes,
    extractPdfText: async () => "Quarterly report",
    ocrPdf: opts.ocrPdf
  });
}

test("readArtifact returns null when the artifact does not exist", async () => {
  const reader = buildReader({ artifact: null, body: Buffer.from("") });
  const result = await reader.readArtifact({ tenantId: "t1", artifactId: "missing" });
  expect(result).toBe(null);
});

test("readContent buffers content under the cap", async () => {
  const reader = buildReader({ artifact: {}, body: Buffer.from("hello world") });
  const input = await reader.readArtifact({ tenantId: "t1", artifactId: "art_1" });
  expect(input).not.toBe(null);
  expect(await input!.readContent()).toBe("hello world");
});

test("readContent throws file_too_large once cumulative bytes exceed the cap", async () => {
  const destroyed: string[] = [];
  const reader = buildReader({
    artifact: {},
    // Two 60-byte chunks; the cap trips on the second.
    body: [Buffer.alloc(60, "a"), Buffer.alloc(60, "b")],
    maxBytes: 100,
    onDestroy: () => destroyed.push("destroyed")
  });
  const input = await reader.readArtifact({ tenantId: "t1", artifactId: "art_1" });
  const error = await input!.readContent().catch((e: unknown) => e);
  expect(error instanceof PiiProtectionServiceError).toBeTruthy();
  expect((error as PiiProtectionServiceError).code).toBe("file_too_large");
  // The stream is torn down rather than drained fully.
  expect(destroyed).toEqual(["destroyed"]);
});

test("readContent allows content exactly at the cap", async () => {
  const reader = buildReader({
    artifact: {},
    body: Buffer.alloc(100, "x"),
    maxBytes: 100
  });
  const input = await reader.readArtifact({ tenantId: "t1", artifactId: "art_1" });
  expect((await input!.readContent()).length).toBe(100);
});

test("readContent marks a PDF verdict as text-only", async () => {
  const reader = buildReader({ artifact: { mimeType: "application/pdf" }, body: Buffer.from("%PDF") });
  const input = await reader.readArtifact({ tenantId: "t1", artifactId: "art_1" });
  expect(await input!.readContent()).toBe("Quarterly report");
  expect(input!.imageCoverage?.()).toEqual({ imageScan: "not_scanned" });
});

test("readContent adds OCR text and records the OCR coverage of a PDF", async () => {
  const ocrPdf = async () => ({ text: "Signed by jane@example.com", status: "partial" as const, pagesScanned: 20,
    pageCount: 30, reason: "page_limit" as const });
  const reader = buildReader({ artifact: { mimeType: "application/pdf" }, body: Buffer.from("%PDF"), ocrPdf });
  const input = await reader.readArtifact({ tenantId: "t1", artifactId: "art_1" });
  expect(input!.imageCoverage?.()).toBeUndefined();
  expect(await input!.readContent()).toBe("Quarterly report\n\nSigned by jane@example.com");
  expect(input!.imageCoverage?.()).toMatchObject({ imageScan: "partial", pagesScanned: 20, pageCount: 30 });
});

test("readContent does not mark a text file", async () => {
  const reader = buildReader({ artifact: {}, body: Buffer.from("hello") });
  const input = await reader.readArtifact({ tenantId: "t1", artifactId: "art_1" });
  await input!.readContent();
  expect(input!.imageCoverage?.()).toBeUndefined();
});

function readerWith(storage: Pick<ArtifactStorage, "openReadStream">, ocrPdf?: PdfOcr, mimeType = "text/plain") {
  return new DatabasePiiScanSubjectReader({
    db: {} as Pool,
    artifacts: { get: async () => ({ artifactId: "art_1", mimeType, storageKey: "key_1" } as ArtifactRecord) },
    storage,
    extractPdfText: async () => "Quarterly report",
    ocrPdf
  });
}

test("readContent passes its signal to storage, and an abort during a stalled body destroys the stream", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  // A body that sends one chunk and then nothing.
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from("partial"));
  const input = await readerWith({
    openReadStream: async (_key, options) => {
      seen.push(options?.signal);
      return { stream, fileSizeBytes: 100 };
    }
  }).readArtifact({ tenantId: "t1", artifactId: "art_1" });
  const controller = new AbortController();
  const reading = input!.readContent(controller.signal);
  await vi.waitFor(() => expect(input!.storageReadInProgress?.()).toBe(true));
  controller.abort(new DOMException("PII artifact evaluation timeout", "AbortError"));
  await expect(reading).rejects.toMatchObject({ code: "pii_storage_unavailable" });
  expect(seen).toEqual([controller.signal]);
  expect(stream.destroyed).toBe(true);
  expect(input!.storageReadInProgress?.()).toBe(false);
});

test.each([
  ["a first-byte timeout", Object.assign(new Error("request timed out"), { name: "TimeoutError" })],
  ["a 503", Object.assign(new Error("ServiceUnavailable"), { $metadata: { httpStatusCode: 503 } })],
  ["a reset socket", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })]
])("readContent turns %s of storage into pii_storage_unavailable", async (_case, failure) => {
  const input = await readerWith({ openReadStream: async () => { throw failure; } })
    .readArtifact({ tenantId: "t1", artifactId: "art_1" });
  await expect(input!.readContent()).rejects.toMatchObject({ code: "pii_storage_unavailable" });
});

test("readContent turns a body that fails mid-stream into pii_storage_unavailable", async () => {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from("partial"));
  setImmediate(() => stream.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" })));
  const input = await readerWith({ openReadStream: async () => ({ stream, fileSizeBytes: 100 }) })
    .readArtifact({ tenantId: "t1", artifactId: "art_1" });
  await expect(input!.readContent()).rejects.toMatchObject({ code: "pii_storage_unavailable" });
});

test("readContent passes a missing object through unchanged", async () => {
  const missing = Object.assign(new Error("The specified key does not exist."), {
    name: "NoSuchKey", $metadata: { httpStatusCode: 404 }
  });
  const input = await readerWith({ openReadStream: async () => { throw missing; } })
    .readArtifact({ tenantId: "t1", artifactId: "art_1" });
  await expect(input!.readContent()).rejects.toBe(missing);
});

test("readContent gives OCR the tenant of the file", async () => {
  const contexts: unknown[] = [];
  const ocrPdf: PdfOcr = async (_pdf, _signal, context) => {
    contexts.push(context);
    return { text: "", status: "complete", pagesScanned: 1, pageCount: 1 };
  };
  const input = await readerWith(
    { openReadStream: async () => ({ stream: Readable.from([Buffer.from("%PDF")]), fileSizeBytes: 4 }) },
    ocrPdf,
    "application/pdf"
  ).readArtifact({ tenantId: "tenant-7", artifactId: "art_1" });
  await input!.readContent();
  expect(contexts).toEqual([{ tenantId: "tenant-7" }]);
});
