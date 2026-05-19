import { Readable } from "node:stream";
import { test, expect } from "vitest";

import type { ArtifactRecord } from "./artifact-store.js";
import type { ArtifactStorage } from "./artifact-storage.js";

import { syncArtifactsToWorkspace } from "./artifact-workspace-sync.js";

function makeArtifact(o: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 1,
    artifactId: "abcdef0123456789",
    sessionId: "s",
    userId: "u",
    artifactType: "upload",
    sourceArtifactId: null,
    artifactName: "report.pdf",
    mimeType: "application/pdf",
    storageBackend: "local",
    storageKey: "k",
    fileSizeBytes: 100,
    checksumSha256: "x",
    status: "ready",
    createdByType: "user",
    createdByRef: null,
    detail: {},
    createdAt: "now",
    updatedAt: "now",
    ...o
  };
}

function makeStorage(textByKey: Record<string, string>): Pick<ArtifactStorage, "openReadStream"> {
  return {
    async openReadStream(key) {
      const body = textByKey[key];
      if (body === undefined) throw new Error("missing");
      return {
        stream: Readable.from([Buffer.from(body)]),
        contentType: "text/plain",
        sizeBytes: body.length
      };
    }
  };
}

function captureWriter() {
  const writes: Array<{ filePath: string; data: Buffer }> = [];
  return {
    writes,
    async writer(_sessionId: string, filePath: string, data: Uint8Array | string) {
      const buf =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      writes.push({ filePath, data: buf });
      return filePath;
    }
  };
}

test("syncs scoped artifacts to ./artifacts/ keeping safe basenames", async () => {
  const arts = [makeArtifact({ artifactName: "report.pdf", storageKey: "k1" })];
  const cap = captureWriter();
  const result = await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage: makeStorage({ k1: "PDF body" }),
    writeRuntimeFile: cap.writer
  });
  expect(result.length).toBe(1);
  expect(result[0].synced).toBe(true);
  expect(result[0].workspacePath).toBe("./artifacts/report.pdf");
  expect(cap.writes[0].data.toString("utf8")).toBe("PDF body");
});

test("dedupes colliding filenames using a short artifactId suffix", async () => {
  const arts = [
    makeArtifact({ artifactId: "id-aaaaaaaa", artifactName: "img.png", storageKey: "k1" }),
    makeArtifact({ artifactId: "id-bbbbbbbb", artifactName: "img.png", storageKey: "k2" }),
    makeArtifact({ artifactId: "id-cccccccc", artifactName: "img.png", storageKey: "k3" })
  ];
  const cap = captureWriter();
  const result = await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage: makeStorage({ k1: "a", k2: "b", k3: "c" }),
    writeRuntimeFile: cap.writer
  });
  // Distinct workspace paths
  const paths = result.map((r) => r.workspacePath);
  expect(new Set(paths).size).toBe(3);
  // The first stays as the bare name
  expect(paths[0]).toBe("./artifacts/img.png");
  // Subsequent get suffix
  expect(paths[1]).toMatch(/^\.\/artifacts\/img_id-bbbbb\.png$/);
});

test("strips path traversal from artifact names", async () => {
  const arts = [
    makeArtifact({ artifactName: "../../etc/passwd", storageKey: "k" })
  ];
  const cap = captureWriter();
  const result = await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage: makeStorage({ k: "x" }),
    writeRuntimeFile: cap.writer
  });
  // basename of '../../etc/passwd' is 'passwd'
  expect(result[0].workspacePath).toBe("./artifacts/passwd");
});

test("artifact name '.' or '..' becomes 'unnamed'", async () => {
  const arts = [
    makeArtifact({ artifactName: ".", storageKey: "k" }),
    makeArtifact({ artifactName: "..", artifactId: "diff-bb", storageKey: "k2" })
  ];
  const cap = captureWriter();
  const result = await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage: makeStorage({ k: "a", k2: "b" }),
    writeRuntimeFile: cap.writer
  });
  expect(result[0].workspacePath).toBe("./artifacts/unnamed");
  // second one should be deduped
  expect(result[1].workspacePath).toMatch(/^\.\/artifacts\/unnamed_diff-bb/);
});

test("empty artifact name falls back to 'unnamed'", async () => {
  const arts = [makeArtifact({ artifactName: "", storageKey: "k" })];
  const cap = captureWriter();
  const result = await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage: makeStorage({ k: "x" }),
    writeRuntimeFile: cap.writer
  });
  expect(result[0].workspacePath).toBe("./artifacts/unnamed");
});

test("artifacts over 10MB are skipped (synced=false) without opening a stream", async () => {
  const arts = [
    makeArtifact({ fileSizeBytes: 11 * 1024 * 1024, artifactName: "huge.bin", storageKey: "k-huge" })
  ];
  let opened = false;
  const storage: Pick<ArtifactStorage, "openReadStream"> = {
    async openReadStream() {
      opened = true;
      throw new Error("should not open");
    }
  };
  const cap = captureWriter();
  const result = await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage,
    writeRuntimeFile: cap.writer
  });
  expect(result[0].synced).toBe(false);
  expect(opened).toBe(false);
  expect(cap.writes.length).toBe(0);
});

test("storage failures are swallowed; artifact is recorded with synced=false", async () => {
  const arts = [makeArtifact({ storageKey: "k-bad" })];
  const storage: Pick<ArtifactStorage, "openReadStream"> = {
    async openReadStream() {
      throw new Error("io broke");
    }
  };
  const cap = captureWriter();
  const result = await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage,
    writeRuntimeFile: cap.writer
  });
  expect(result[0].synced).toBe(false);
  expect(cap.writes.length).toBe(0);
});

test("write failures are swallowed; artifact recorded with synced=false", async () => {
  const arts = [makeArtifact({ storageKey: "k", artifactName: "x.txt" })];
  const result = await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage: makeStorage({ k: "data" }),
    writeRuntimeFile: async () => {
      throw new Error("write broke");
    }
  });
  expect(result[0].synced).toBe(false);
  expect(result[0].workspacePath).toBe("./artifacts/x.txt");
});

test("string-typed stream chunks are coerced to bytes", async () => {
  const arts = [makeArtifact({ storageKey: "k", artifactName: "f.txt" })];
  const storage: Pick<ArtifactStorage, "openReadStream"> = {
    async openReadStream() {
      // Yield raw strings (some streams do this)
      return {
        stream: Readable.from(["hello", " world"]),
        contentType: "text/plain",
        sizeBytes: 11
      };
    }
  };
  const cap = captureWriter();
  await syncArtifactsToWorkspace({
    sessionId: "s",
    scopedArtifacts: arts,
    storage,
    writeRuntimeFile: cap.writer
  });
  expect(cap.writes[0].data.toString("utf8")).toBe("hello world");
});
