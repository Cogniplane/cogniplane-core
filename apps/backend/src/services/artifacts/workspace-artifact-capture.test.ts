import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test, expect, describe, afterEach } from "vitest";

import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import type { ArtifactRecord } from "./artifact-store.js";
import type { ArtifactStorage } from "./artifact-storage.js";
import { captureWorkspaceArtifacts } from "./workspace-artifact-capture.js";

type CreateInput = Parameters<
  Parameters<typeof captureWorkspaceArtifacts>[0]["artifacts"]["create"]
>[0];

type ArtifactsFake = {
  records: ArtifactRecord[];
  create: (input: CreateInput) => Promise<ArtifactRecord>;
  listBySession: (
    tenantId: string,
    sessionId: string,
    userId: string
  ) => Promise<ArtifactRecord[]>;
};

function makeArtifactsFake(seed: ArtifactRecord[] = []): ArtifactsFake {
  const records: ArtifactRecord[] = [...seed];
  let counter = records.length;
  return {
    records,
    async create(input) {
      counter += 1;
      const rec: ArtifactRecord = {
        id: counter,
        artifactId: `artifact-${counter}`,
        sessionId: input.sessionId,
        userId: input.userId,
        artifactType: input.artifactType,
        sourceArtifactId: input.sourceArtifactId ?? null,
        artifactName: input.artifactName,
        mimeType: input.mimeType,
        storageBackend: input.storageBackend,
        storageKey: input.storageKey,
        fileSizeBytes: input.fileSizeBytes,
        checksumSha256: input.checksumSha256,
        status: input.status,
        createdByType: input.createdByType,
        createdByRef: input.createdByRef ?? null,
        detail: input.detail ?? {},
        createdAt: "now",
        updatedAt: "now"
      };
      records.push(rec);
      return rec;
    },
    async listBySession(_t, sessionId, _u) {
      return records.filter((r) => r.sessionId === sessionId);
    }
  };
}

type StorageFake = {
  puts: Array<{ storageKey: string; bytes: number }>;
  storage: Pick<ArtifactStorage, "put">;
  failOnce?: boolean;
};

function makeStorage(opts: { failKey?: string } = {}): StorageFake {
  const puts: Array<{ storageKey: string; bytes: number }> = [];
  const storage: Pick<ArtifactStorage, "put"> = {
    async put(input) {
      // Drain the readable stream to count bytes
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks);
      if (opts.failKey && input.storageKey === opts.failKey) {
        throw new Error("storage failure (test)");
      }
      puts.push({ storageKey: input.storageKey, bytes: data.length });
      return {
        storageBackend: "local",
        storageKey: input.storageKey,
        fileSizeBytes: data.length
      };
    }
  };
  return { puts, storage };
}

describe("captureWorkspaceArtifacts", () => {
  let workspace: string;

  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  async function setupWorkspace(): Promise<string> {
    workspace = await mkdtemp(path.join(os.tmpdir(), "ws-capture-"));
    return workspace;
  }

  test("captures supported text/code files with the correct mime type", async () => {
    const ws = await setupWorkspace();
    await writeFile(path.join(ws, "report.md"), "# Hello");
    await writeFile(path.join(ws, "config.json"), '{"x":1}');
    await writeFile(path.join(ws, "script.py"), "print('x')");

    const artifacts = makeArtifactsFake();
    const { storage, puts } = makeStorage();
    const auditEvents = new InMemoryAuditEventStore();

    await captureWorkspaceArtifacts({
      tenantId: "t1",
      sessionId: "s1",
      userId: "u1",
      workspacePath: ws,
      artifacts: artifacts as unknown as Parameters<typeof captureWorkspaceArtifacts>[0]["artifacts"],
      storage: storage as unknown as ArtifactStorage,
      auditEvents
    });

    expect(artifacts.records).toHaveLength(3);
    expect(puts).toHaveLength(3);
    expect(auditEvents.events).toHaveLength(3);
    const byName = new Map(artifacts.records.map((r) => [r.artifactName, r]));
    expect(byName.get("report.md")?.mimeType).toBe("text/markdown");
    expect(byName.get("config.json")?.mimeType).toBe("application/json");
    expect(byName.get("script.py")?.mimeType).toBe("text/x-python");
    for (const ev of auditEvents.events) {
      expect(ev.type).toBe("artifact_generated");
      expect(ev.payload.source).toBe("workspace-sweep");
    }
  });

  test("skips dotfiles and excluded directories at the top level", async () => {
    const ws = await setupWorkspace();
    await mkdir(path.join(ws, ".codex"));
    await mkdir(path.join(ws, "node_modules"));
    await mkdir(path.join(ws, "artifacts"));
    await mkdir(path.join(ws, ".framework"));
    await mkdir(path.join(ws, ".git"));
    await writeFile(path.join(ws, ".codex", "skip.md"), "skip");
    await writeFile(path.join(ws, "node_modules", "skip.js"), "x");
    await writeFile(path.join(ws, "artifacts", "skip.txt"), "x");
    await writeFile(path.join(ws, ".framework", "skip.json"), "{}");
    await writeFile(path.join(ws, ".hidden.md"), "skip");
    await writeFile(path.join(ws, "AGENTS.md"), "skip");
    await writeFile(path.join(ws, "real.md"), "keep");

    const artifacts = makeArtifactsFake();
    const { storage } = makeStorage();
    const auditEvents = new InMemoryAuditEventStore();
    await captureWorkspaceArtifacts({
      tenantId: "t1",
      sessionId: "s1",
      userId: "u1",
      workspacePath: ws,
      artifacts: artifacts as never,
      storage: storage as ArtifactStorage,
      auditEvents
    });

    expect(artifacts.records.map((r) => r.artifactName)).toEqual(["real.md"]);
  });

  test("walks nested directories beyond the top level", async () => {
    const ws = await setupWorkspace();
    await mkdir(path.join(ws, "src", "deep"), { recursive: true });
    await writeFile(path.join(ws, "src", "deep", "x.ts"), "export const x = 1;");

    const artifacts = makeArtifactsFake();
    const { storage } = makeStorage();
    const auditEvents = new InMemoryAuditEventStore();
    await captureWorkspaceArtifacts({
      tenantId: "t",
      sessionId: "s",
      userId: "u",
      workspacePath: ws,
      artifacts: artifacts as never,
      storage: storage as ArtifactStorage,
      auditEvents
    });
    expect(artifacts.records.map((r) => r.artifactName)).toEqual(["x.ts"]);
  });

  test("skips files with extensions outside the sweep allowlist", async () => {
    const ws = await setupWorkspace();
    await writeFile(path.join(ws, "binary.exe"), "noop");
    await writeFile(path.join(ws, "README.md"), "ok");

    const artifacts = makeArtifactsFake();
    const { storage } = makeStorage();
    const auditEvents = new InMemoryAuditEventStore();
    await captureWorkspaceArtifacts({
      tenantId: "t",
      sessionId: "s",
      userId: "u",
      workspacePath: ws,
      artifacts: artifacts as never,
      storage: storage as ArtifactStorage,
      auditEvents
    });
    expect(artifacts.records.map((r) => r.artifactName)).toEqual(["README.md"]);
  });

  test("dedupes against artifacts already recorded for the session", async () => {
    const ws = await setupWorkspace();
    await writeFile(path.join(ws, "report.md"), "# v2");

    // Pre-existing artifact captured from this exact workspace path by a prior
    // sweep. Idempotency is keyed on `detail.workspacePath`, so re-running the
    // sweep must skip it.
    const seed: ArtifactRecord = {
      id: 1,
      artifactId: "old-1",
      sessionId: "s",
      userId: "u",
      artifactType: "generated",
      sourceArtifactId: null,
      artifactName: "report.md",
      mimeType: "text/markdown",
      storageBackend: "local",
      storageKey: "old-key",
      fileSizeBytes: 5,
      checksumSha256: "old",
      status: "ready",
      createdByType: "system",
      createdByRef: "workspace-sweep",
      detail: { source: "workspace-sweep", workspacePath: path.join(ws, "report.md") },
      createdAt: "before",
      updatedAt: "before"
    };
    const artifacts = makeArtifactsFake([seed]);
    const { storage, puts } = makeStorage();
    const auditEvents = new InMemoryAuditEventStore();

    await captureWorkspaceArtifacts({
      tenantId: "t",
      sessionId: "s",
      userId: "u",
      workspacePath: ws,
      artifacts: artifacts as never,
      storage: storage as ArtifactStorage,
      auditEvents
    });

    // No new puts, no new artifacts created, no audit events
    expect(puts).toHaveLength(0);
    expect(artifacts.records).toHaveLength(1);
    expect(auditEvents.events).toHaveLength(0);
  });

  test("skips empty files and files larger than the per-mime cap", async () => {
    const ws = await setupWorkspace();
    await writeFile(path.join(ws, "empty.md"), "");
    await writeFile(path.join(ws, "huge.md"), "x".repeat(500_001)); // >500KB text cap
    await writeFile(path.join(ws, "ok.md"), "x".repeat(100));

    const artifacts = makeArtifactsFake();
    const { storage } = makeStorage();
    const auditEvents = new InMemoryAuditEventStore();
    await captureWorkspaceArtifacts({
      tenantId: "t",
      sessionId: "s",
      userId: "u",
      workspacePath: ws,
      artifacts: artifacts as never,
      storage: storage as ArtifactStorage,
      auditEvents
    });
    expect(artifacts.records.map((r) => r.artifactName)).toEqual(["ok.md"]);
  });

  test("does not throw when storage.put fails for one file; other files are still captured", async () => {
    const ws = await setupWorkspace();
    // Differentiate files by content so the storage fake can pick which to fail.
    await writeFile(path.join(ws, "good.md"), "GOOD_CONTENT");
    await writeFile(path.join(ws, "bad.md"), "BAD_CONTENT");

    const artifacts = makeArtifactsFake();
    const failingStorage: Pick<ArtifactStorage, "put"> = {
      async put(input) {
        const chunks: Buffer[] = [];
        for await (const c of input.stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const buf = Buffer.concat(chunks);
        if (buf.toString() === "BAD_CONTENT") {
          throw new Error("simulated storage failure");
        }
        return {
          storageBackend: "local",
          storageKey: input.storageKey,
          fileSizeBytes: buf.length
        };
      }
    };
    const auditEvents = new InMemoryAuditEventStore();

    await expect(
      captureWorkspaceArtifacts({
        tenantId: "t",
        sessionId: "s",
        userId: "u",
        workspacePath: ws,
        artifacts: artifacts as never,
        storage: failingStorage as ArtifactStorage,
        auditEvents
      })
    ).resolves.toBeUndefined();
    // Only the file whose put() succeeded should be recorded; the failed
    // one is silently dropped from the sweep (the catch branch in
    // captureWorkspaceArtifacts swallows the error and returns).
    expect(artifacts.records.map((r) => r.artifactName)).toEqual(["good.md"]);
    // No audit event should have been emitted for the failed artifact.
    expect(auditEvents.events.map((e) => e.payload.artifactName)).toEqual(["good.md"]);
  });

  test("returns silently when workspacePath does not exist", async () => {
    const artifacts = makeArtifactsFake();
    const { storage } = makeStorage();
    const auditEvents = new InMemoryAuditEventStore();
    await expect(
      captureWorkspaceArtifacts({
        tenantId: "t",
        sessionId: "s",
        userId: "u",
        workspacePath: "/tmp/does-not-exist-cogniplane-test-" + Date.now(),
        artifacts: artifacts as never,
        storage: storage as ArtifactStorage,
        auditEvents
      })
    ).resolves.toBeUndefined();
    expect(artifacts.records).toHaveLength(0);
  });

  test("captures images with the image mime type and the larger image cap", async () => {
    const ws = await setupWorkspace();
    // 1MB png — within 5MB image cap
    await writeFile(path.join(ws, "diagram.png"), Buffer.alloc(1_000_000, 0xff));
    const artifacts = makeArtifactsFake();
    const { storage } = makeStorage();
    const auditEvents = new InMemoryAuditEventStore();
    await captureWorkspaceArtifacts({
      tenantId: "t",
      sessionId: "s",
      userId: "u",
      workspacePath: ws,
      artifacts: artifacts as never,
      storage: storage as ArtifactStorage,
      auditEvents
    });
    expect(artifacts.records.map((r) => r.mimeType)).toEqual(["image/png"]);
  });
});
