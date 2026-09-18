import { Readable } from "node:stream";
import { test, expect } from "vitest";

import type { ArtifactProcessor } from "./artifacts/artifact-processor.js";
import type { ArtifactRecord } from "./artifacts/artifact-store.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import type { SyncedArtifact } from "./artifacts/artifact-workspace-sync.js";

import { buildArtifactTurnInputs } from "./turn-input-builder.js";

function makeArtifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 1,
    artifactId: "art-1",
    sessionId: "sess-1",
    userId: "user-1",
    artifactType: "upload",
    sourceArtifactId: null,
    artifactName: "notes.txt",
    mimeType: "text/plain",
    storageBackend: "local",
    storageKey: "tenant/sess/notes.txt",
    fileSizeBytes: 12,
    checksumSha256: "deadbeef",
    status: "ready",
    createdByType: "user",
    createdByRef: null,
    detail: {},
    createdAt: "2026-04-28T00:00:00Z",
    updatedAt: "2026-04-28T00:00:00Z",
    ...overrides
  };
}

function makeStorage(textByKey: Record<string, string>): Pick<ArtifactStorage, "openReadStream"> {
  return {
    async openReadStream(storageKey) {
      const body = textByKey[storageKey] ?? "";
      return {
        stream: Readable.from([Buffer.from(body, "utf8")]),
        fileSizeBytes: Buffer.byteLength(body)
      };
    }
  };
}

function makeProcessor(opts: {
  text?: (artifact: Parameters<ArtifactProcessor["extractArtifactText"]>[0]) => string | null | Promise<string | null>;
  textThrows?: boolean;
}): Pick<ArtifactProcessor, "extractArtifactText"> {
  return {
    async extractArtifactText(artifact) {
      if (opts.textThrows) throw new Error("extract failed");
      const result = opts.text ? await opts.text(artifact) : null;
      return result ?? null;
    }
  };
}

test("returns no userInputs when there are no scoped artifacts", async () => {
  const result = await buildArtifactTurnInputs({
    prompt: "hello",
    scopedArtifacts: [],
    artifactProcessor: makeProcessor({}),
    storage: makeStorage({})
  });

  expect(result.userInputs).toBe(undefined);
});

test("inlines text from a readable text artifact via the storage stream", async () => {
  const artifact = makeArtifact({
    artifactName: "notes.txt",
    mimeType: "text/plain",
    storageKey: "k1"
  });

  const result = await buildArtifactTurnInputs({
    prompt: "summarize",
    scopedArtifacts: [artifact],
    artifactProcessor: makeProcessor({}),
    storage: makeStorage({ k1: "hello world" })
  });

  expect(result.userInputs).toBeTruthy();
  expect(result.userInputs!.length).toBe(1);
  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).toMatch(/hello world/);
  expect(text).toMatch(/Readable artifact: notes.txt/);
  // Tail prompt is preserved
  expect(text).toMatch(/\nsummarize$/);
});

test("application/json is treated as text-readable", async () => {
  const artifact = makeArtifact({
    artifactName: "data.json",
    mimeType: "application/json",
    storageKey: "k2"
  });

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [artifact],
    artifactProcessor: makeProcessor({}),
    storage: makeStorage({ k2: "{\"k\":1}" })
  });

  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).toMatch(/\{"k":1\}/);
});

test("skips a text artifact whose body is whitespace-only", async () => {
  const artifact = makeArtifact({
    artifactName: "empty.txt",
    mimeType: "text/plain",
    storageKey: "k3"
  });

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [artifact],
    artifactProcessor: makeProcessor({}),
    storage: makeStorage({ k3: "   \n  " })
  });

  const text = (result.userInputs![0] as { text: string }).text;
  // No fenced "Artifact content" block since the excerpt was blank
  expect(text).not.toMatch(/Artifact content:/);
  // But the metadata fallback list still mentions the artifact
  expect(text).toMatch(/empty\.txt/);
});

test("skips non-text non-PDF artifacts entirely (e.g. arbitrary binary)", async () => {
  const artifact = makeArtifact({
    artifactName: "blob.bin",
    mimeType: "application/octet-stream",
    storageKey: "k4"
  });

  const processor = makeProcessor({
    text: () => "should-not-be-called"
  });

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [artifact],
    artifactProcessor: processor,
    storage: makeStorage({})
  });

  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).not.toMatch(/Artifact content:/);
  // Non-PDF binaries do not produce image inputs
  expect(result.userInputs!.length).toBe(1);
});

test("PDF artifact: extracts text and inlines it", async () => {
  const pdf = makeArtifact({
    artifactName: "deck.pdf",
    mimeType: "application/pdf",
    storageKey: "kpdf"
  });

  const processor = makeProcessor({
    text: () => "PDF body text"
  });

  const result = await buildArtifactTurnInputs({
    prompt: "describe",
    scopedArtifacts: [pdf],
    artifactProcessor: processor,
    storage: makeStorage({})
  });

  expect(result.userInputs!.length).toBe(1);
  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).toMatch(/Extracted on demand from PDF: deck\.pdf/);
  expect(text).toMatch(/PDF body text/);
});

test("PDF artifact: text extraction failure is swallowed", async () => {
  const pdf = makeArtifact({ mimeType: "application/pdf", storageKey: "k5", artifactName: "x.pdf" });
  const processor = makeProcessor({
    textThrows: true
  });

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [pdf],
    artifactProcessor: processor,
    storage: makeStorage({})
  });

  expect(result.userInputs!.length).toBe(1);
  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).not.toMatch(/Artifact content: x\.pdf/);
  expect(text).toMatch(/Answer only from the visible artifact metadata/);
});

test("synced artifacts are referenced by workspace path and not re-read", async () => {
  const a = makeArtifact({ artifactId: "a1", artifactName: "a.txt", mimeType: "text/plain", storageKey: "ka" });
  const synced: SyncedArtifact[] = [
    { artifact: a, workspacePath: "./artifacts/a.txt", synced: true }
  ];
  const calls: string[] = [];
  const storage: Pick<ArtifactStorage, "openReadStream"> = {
    async openReadStream(key) {
      calls.push(key);
      return {
        stream: Readable.from([Buffer.from("zz")]),
        fileSizeBytes: 2
      };
    }
  };

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [a],
    artifactProcessor: makeProcessor({}),
    storage,
    syncedArtifacts: synced
  });

  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).toMatch(/Session artifacts have been synced/);
  expect(text).toMatch(/\.\/artifacts\/a\.txt \(a1; text\/plain; upload\)/);
  // No fallback inline read happened for synced artifacts
  expect(calls.length).toBe(0);
});

test("mix of synced and unsynced artifacts: lists synced and falls back for the rest", async () => {
  const a = makeArtifact({ artifactId: "a1", artifactName: "a.txt", mimeType: "text/plain", storageKey: "ka" });
  const b = makeArtifact({ artifactId: "b1", artifactName: "b.txt", mimeType: "text/plain", storageKey: "kb" });
  const syncedArtifacts: SyncedArtifact[] = [
    { artifact: a, workspacePath: "./artifacts/a.txt", synced: true },
    // synced=false should be ignored when building the synced map
    { artifact: b, workspacePath: "./artifacts/b.txt", synced: false }
  ];

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [a, b],
    artifactProcessor: makeProcessor({}),
    storage: makeStorage({ kb: "B body" }),
    syncedArtifacts
  });

  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).toMatch(/Session artifacts have been synced/);
  expect(text).toMatch(/could not be synced to the workspace/);
  expect(text).toMatch(/B body/);
});

test("more than 20 fallback artifacts: only the first 20 are listed by name", async () => {
  const many: ArtifactRecord[] = Array.from({ length: 25 }, (_, i) =>
    makeArtifact({
      artifactId: `id-${i}`,
      artifactName: `f${i}.bin`,
      mimeType: "application/octet-stream",
      storageKey: `k${i}`
    })
  );

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: many,
    artifactProcessor: makeProcessor({}),
    storage: makeStorage({})
  });

  const text = (result.userInputs![0] as { text: string }).text;
  // First 20 listed
  expect(text).toMatch(/f0\.bin/);
  expect(text).toMatch(/f19\.bin/);
  // 20+ omitted
  expect(text).not.toMatch(/f20\.bin/);
  expect(text).not.toMatch(/f24\.bin/);
});

test("artifact text budget: earlier large artifacts exhaust the budget for later ones", async () => {
  // Per-artifact excerpt cap is 6,000; total budget is 18,000. Three full
  // artifacts at 6,000 chars each exhaust the budget; the fourth must not
  // be read or inlined.
  const fill = "x".repeat(6_000);
  const a = makeArtifact({ artifactId: "a1", artifactName: "a.txt", mimeType: "text/plain", storageKey: "ka" });
  const b = makeArtifact({ artifactId: "b1", artifactName: "b.txt", mimeType: "text/plain", storageKey: "kb" });
  const c = makeArtifact({ artifactId: "c1", artifactName: "c.txt", mimeType: "text/plain", storageKey: "kc" });
  const d = makeArtifact({ artifactId: "d1", artifactName: "d.txt", mimeType: "text/plain", storageKey: "kd" });

  const reads: string[] = [];
  const storage: Pick<ArtifactStorage, "openReadStream"> = {
    async openReadStream(key) {
      reads.push(key);
      const body =
        key === "ka" || key === "kb" || key === "kc" ? fill : "after-budget-token";
      return {
        stream: Readable.from([Buffer.from(body)]),
        fileSizeBytes: body.length
      };
    }
  };

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [a, b, c, d],
    artifactProcessor: makeProcessor({}),
    storage
  });

  const text = (result.userInputs![0] as { text: string }).text;
  // First three artifacts inline their bodies.
  expect(text).toMatch(/Artifact content: a\.txt/);
  expect(text).toMatch(/Artifact content: c\.txt/);
  // The fourth artifact's body MUST NOT be inlined.
  expect(text).not.toMatch(/after-budget-token/);
  expect(text).not.toMatch(/Artifact content: d\.txt/);
  // The fourth artifact's storage MUST NOT be read once the budget is exhausted.
  expect(!reads.includes("kd")).toBeTruthy();
  // Its metadata still appears in the fallback list.
  expect(text).toMatch(/d\.txt/);
});

test("when no inline blocks or images attach, the metadata-only guidance line is emitted", async () => {
  const blob = makeArtifact({ mimeType: "application/octet-stream", storageKey: "k", artifactName: "x.bin" });

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [blob],
    artifactProcessor: makeProcessor({}),
    storage: makeStorage({})
  });

  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).toMatch(/Answer only from the visible artifact metadata/);
});

test("when inline blocks exist, the embedded-source guidance line is emitted (no synced files)", async () => {
  const a = makeArtifact({ mimeType: "text/plain", storageKey: "ka", artifactName: "a.txt" });

  const result = await buildArtifactTurnInputs({
    prompt: "p",
    scopedArtifacts: [a],
    artifactProcessor: makeProcessor({}),
    storage: makeStorage({ ka: "hi" })
  });

  const text = (result.userInputs![0] as { text: string }).text;
  expect(text).toMatch(/Use the embedded artifact text blocks as the primary source material/);
  expect(text).not.toMatch(/Answer only from the visible artifact metadata/);
});
