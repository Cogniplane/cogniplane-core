import { Readable } from "node:stream";

import { test, expect } from "vitest";

import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactRecord, ArtifactStore } from "../artifacts/artifact-store.js";
import type { Pool } from "../../lib/db.js";
import type { MessageStore } from "../message-store.js";
import { PiiProtectionServiceError } from "./pii-protection-service.js";
import { DatabasePiiScanSubjectReader } from "./pii-scan-subject-reader.js";

function buildReader(opts: {
  artifact: Partial<ArtifactRecord> | null;
  body: Buffer | Buffer[];
  maxBytes?: number;
  onDestroy?: () => void;
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
      return { stream } as Awaited<ReturnType<ArtifactStorage["openReadStream"]>>;
    }
  };
  return new DatabasePiiScanSubjectReader({
    db: {} as Pool,
    messages: {} as MessageStore,
    artifacts: artifacts as ArtifactStore,
    storage: storage as ArtifactStorage,
    maxBytes: opts.maxBytes
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
