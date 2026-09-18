import { Readable } from "node:stream";
import { test, expect, vi } from "vitest";

import type { ArtifactRecord } from "../artifacts/artifact-store.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";

import { createWriteArtifactTool, inferMimeType } from "./write-artifact.js";

function ctx(o: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolContextId: "ctx-1",
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    runtimeId: "rt",
    runtimePolicyId: "default",
    messageId: "m1",
    credentialEnvelope: {},
    metadata: {},
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...o
  };
}

function makeDeps(opts: {
  putReturns?: Partial<{ storageBackend: "local" | "bucket"; storageKey: string; fileSizeBytes: number; checksumSha256: string }>;
  artifactReturns?: Partial<ArtifactRecord>;
  putThrows?: boolean;
  createThrows?: boolean;
  readRuntimeFile?: (s: string, r: string, p: string) => Promise<Uint8Array>;
  artifactMaxBytes?: number;
} = {}) {
  const auditCalls: unknown[] = [];
  const artifactCalls: unknown[] = [];
  const storageCalls: Array<{ storageKey: string }> = [];
  const deleteCalls: string[] = [];
  const deps: Parameters<typeof createWriteArtifactTool>[0] = {
    artifacts: {
      async createGenerated(input) {
        artifactCalls.push(input);
        if (opts.createThrows) throw new Error("artifact create failed");
        const artifact: ArtifactRecord = {
          id: 1,
          artifactId: "a-1",
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
          updatedAt: "now",
          ...opts.artifactReturns
        };
        return artifact;
      }
    },
    storage: {
      async put(input) {
        storageCalls.push({ storageKey: input.storageKey });
        if (opts.putThrows) throw new Error("storage put failed");
        for await (const _ of input.stream) {
          // Drain the stream so the buffer is consumed.
        }
        return {
          storageBackend: opts.putReturns?.storageBackend ?? "local",
          storageKey: opts.putReturns?.storageKey ?? input.storageKey,
          fileSizeBytes: opts.putReturns?.fileSizeBytes ?? 4,
          checksumSha256: opts.putReturns?.checksumSha256 ?? "stored-csum"
        };
      },
      async openReadStream() {
        return { stream: Readable.from([]), fileSizeBytes: 0 };
      },
      async delete(storageKey) {
        deleteCalls.push(storageKey);
      }
    },
    auditEvents: {
      async create(input) {
        auditCalls.push(input);
      }
    },
    artifactMaxBytes: opts.artifactMaxBytes ?? 10_000_000,
    readRuntimeFile: opts.readRuntimeFile
  };
  return {
    auditCalls,
    artifactCalls,
    storageCalls,
    deleteCalls,
    deps
  };
}

const tool = (deps: ReturnType<typeof makeDeps>["deps"]) =>
  createWriteArtifactTool(deps).find(
    (x) => x.name === "write_artifact"
  )!;

// inferMimeType

test("inferMimeType: returns text/plain for filenames without extension", () => {
  expect(inferMimeType("README")).toBe("text/plain");
});

test("inferMimeType: returns mapped mime for known extensions and is case-insensitive", () => {
  expect(inferMimeType("a.PY")).toBe("text/x-python");
  expect(inferMimeType("a.json")).toBe("application/json");
  expect(inferMimeType("img.PNG")).toBe("image/png");
});

test("inferMimeType: unknown extensions fall back to text/plain", () => {
  expect(inferMimeType("a.unknownext")).toBe("text/plain");
});

// write_artifact handler

test("write_artifact: requires name", async () => {
  const { deps } = makeDeps();
  await expect(() => tool(deps).handler({ context: ctx(), arguments: { content: "x" } })).rejects.toThrow(/name is required/);
});

test("write_artifact: requires either content or filePath", async () => {
  const { deps } = makeDeps();
  await expect(() => tool(deps).handler({ context: ctx(), arguments: { name: "x.txt" } })).rejects.toThrow(/Either content or filePath is required/);
});

test("write_artifact: rejects when both content and filePath are given", async () => {
  const { deps } = makeDeps();
  await expect(() =>
        tool(deps).handler({
          context: ctx(),
          arguments: { name: "x.txt", content: "hi", filePath: "./x.txt" }
        })).rejects.toThrow(/Provide content or filePath, not both/);
});

test("write_artifact: filePath rejected when readRuntimeFile not configured", async () => {
  const { deps } = makeDeps(); // no readRuntimeFile
  await expect(() =>
        tool(deps).handler({
          context: ctx(),
          arguments: { name: "x.txt", filePath: "./x.txt" }
        })).rejects.toThrow(/filePath is not supported on this runtime backend/);
});

test("write_artifact: rejects empty content", async () => {
  const { deps } = makeDeps({ readRuntimeFile: async () => new Uint8Array() });
  await expect(() => tool(deps).handler({ context: ctx(), arguments: { name: "x.txt", filePath: "./x" } })).rejects.toThrow(/File is empty/);
});

test("write_artifact: rejects content above the configured artifact limit", async () => {
  const huge = new Uint8Array(10_000_001);
  const { deps } = makeDeps({ readRuntimeFile: async () => huge });
  await expect(() => tool(deps).handler({ context: ctx(), arguments: { name: "x.bin", filePath: "./x" } })).rejects.toThrow(/File too large/);
});

test("write_artifact: enforces a non-default configured artifact limit", async () => {
  const { deps } = makeDeps({ artifactMaxBytes: 3 });
  await expect(() => tool(deps).handler({
    context: ctx(),
    arguments: { name: "note.txt", content: "four" }
  })).rejects.toThrow(/File too large/);
});

test("write_artifact (content path): creates artifact with inferred MIME and emits audit", async () => {
  const { deps, artifactCalls, auditCalls } = makeDeps();
  const result = await tool(deps).handler({
    context: ctx(),
    arguments: { name: "data.json", content: "{\"k\":1}" }
  });
  expect(artifactCalls.length).toBe(1);
  const created = artifactCalls[0] as Record<string, unknown>;
  expect(created.artifactType).toBe("generated");
  expect(created.mimeType).toBe("application/json");
  expect(created.createdByType).toBe("tool");
  expect(created.createdByRef).toBe("m1");
  expect(auditCalls.length).toBe(1);
  expect((auditCalls[0] as Record<string, unknown>).type).toBe("artifact_generated");
  expect((result as Record<string, unknown>).artifactId).toBe("a-1");
});

test("write_artifact: removes the stored object when the artifact insert fails", async () => {
  const { deps, storageCalls, deleteCalls } = makeDeps({ createThrows: true });

  await expect(() => tool(deps).handler({
    context: ctx(),
    arguments: { name: "failed.txt", content: "orphan me" }
  })).rejects.toThrow("artifact create failed");

  expect(deleteCalls).toEqual([storageCalls[0]?.storageKey]);
});

test("write_artifact: saves a permitted project output as a draft while keeping the session artifact", async () => {
  const { deps } = makeDeps({ artifactMaxBytes: 7 });
  const createAgentDraftFromContent = vi.fn().mockResolvedValue({
    fileId: "project-draft-1",
    targetFileId: null
  });
  const result = await tool({
    ...deps,
    projectFiles: { createAgentDraftFromContent }
  }).handler({
    context: ctx({
      metadata: {
        projectContext: { projectId: "project-1", agentFileMode: "create-only" },
        runtimePolicy: { enabledToolIds: ["project_write_file"] }
      }
    }),
    arguments: { name: "report.md", content: "draft" }
  });

  expect(result).toMatchObject({ artifactId: "a-1", projectDraftId: "project-draft-1" });
  expect(createAgentDraftFromContent).toHaveBeenCalledWith(expect.objectContaining({
    actor: { tenantId: "t", userId: "u", projectId: "project-1" },
    name: "report.md",
    targetFileId: null,
    baseVersionId: null,
    mimeType: "text/markdown",
    maxBytes: 7
  }));
});

test("write_artifact: keeps the session artifact when the automatic project draft fails", async () => {
  const { deps, auditCalls, artifactCalls } = makeDeps();
  const createAgentDraftFromContent = vi.fn().mockRejectedValue(new Error("project draft failed"));
  const result = await tool({
    ...deps,
    projectFiles: { createAgentDraftFromContent }
  }).handler({
    context: ctx({
      metadata: {
        projectContext: { projectId: "project-1", agentFileMode: "create-only" },
        runtimePolicy: { enabledToolIds: ["project_write_file"] }
      }
    }),
    arguments: { name: "report.md", content: "draft" }
  });

  expect(result).toMatchObject({
    artifactId: "a-1",
    projectDraftId: null,
    projectDraftError: "The session artifact was saved, but the project draft could not be created."
  });
  expect(artifactCalls).toHaveLength(1);
  expect(auditCalls).toHaveLength(1);
});

test("write_artifact: does not create a project draft when the project tool is disabled", async () => {
  const { deps } = makeDeps();
  const createAgentDraftFromContent = vi.fn();
  const result = await tool({
    ...deps,
    projectFiles: { createAgentDraftFromContent }
  }).handler({
    context: ctx({
      metadata: {
        projectContext: { projectId: "project-1", agentFileMode: "create-only" },
        runtimePolicy: { enabledToolIds: [] }
      }
    }),
    arguments: { name: "report.md", content: "draft" }
  });

  expect(result).toMatchObject({ artifactId: "a-1", projectDraftId: null });
  expect(createAgentDraftFromContent).not.toHaveBeenCalled();
});

test("write_artifact: read-write mode updates a matching published file draft", async () => {
  const { deps } = makeDeps();
  const createAgentDraftFromContent = vi.fn().mockResolvedValue({ fileId: "draft-1" });
  await tool({
    ...deps,
    projectFiles: { createAgentDraftFromContent }
  }).handler({
    context: ctx({
      metadata: {
        projectContext: {
          projectId: "project-1",
          agentFileMode: "read-write",
          snapshot: {
            files: [{
              fileId: "file-1",
              versionId: "version-7",
              name: "Report.md",
              folderId: null,
              kind: "published"
            }]
          }
        },
        runtimePolicy: { enabledToolIds: ["project_write_file"] }
      }
    }),
    arguments: { name: "report.md", content: "draft" }
  });

  expect(createAgentDraftFromContent).toHaveBeenCalledWith(expect.objectContaining({
    targetFileId: "file-1",
    baseVersionId: "version-7",
    stored: expect.objectContaining({ storageKey: expect.any(String) })
  }));
});

test("write_artifact: explicit mimeType overrides extension inference", async () => {
  const { deps, artifactCalls } = makeDeps();
  await tool(deps).handler({
    context: ctx(),
    arguments: { name: "report.txt", content: "hi", mimeType: "text/markdown" }
  });
  expect((artifactCalls[0] as Record<string, unknown>).mimeType).toBe("text/markdown");
});

test("write_artifact (filePath path): reads bytes from runtime", async () => {
  let observedPath = "";
  const { deps, storageCalls } = makeDeps({
    readRuntimeFile: async (_s, _r, p) => {
      observedPath = p;
      return new TextEncoder().encode("from-disk");
    }
  });
  await tool(deps).handler({
    context: ctx(),
    arguments: { name: "out.txt", filePath: "  ./out.txt  " }
  });
  expect(observedPath).toBe("./out.txt");
  expect(storageCalls.length === 1).toBeTruthy();
});

test("write_artifact: filename without extension yields no extension on storage key", async () => {
  const { deps, storageCalls } = makeDeps();
  await tool(deps).handler({
    context: ctx(),
    arguments: { name: "noext", content: "data" }
  });
  // The load-bearing contract is extension handling, not the internal key
  // layout: a name with no dot yields NO trailing extension. Assert that, not
  // the u/s/uuid prefix (a private storage.put() detail).
  const key = storageCalls[0].storageKey;
  expect(key.includes(".")).toBe(false);
});

test("write_artifact: extension is sanitized of unsafe chars", async () => {
  const { deps, storageCalls } = makeDeps();
  await tool(deps).handler({
    context: ctx(),
    // Tricky filename with a leading dot in the "extension"
    arguments: { name: "weird.tar.g$", content: "x" }
  });
  // The load-bearing contract is extension sanitization: the unsafe `$` is
  // stripped, leaving `.g`. Assert the sanitized suffix, not the u/s/uuid prefix.
  const key = storageCalls[0].storageKey;
  expect(key.endsWith(".g")).toBe(true);
  expect(key).not.toContain("$");
});
