import { test, expect } from "vitest";

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
  artifactReturns?: Record<string, unknown>;
  putThrows?: boolean;
  readRuntimeFile?: (s: string, r: string, p: string) => Promise<Uint8Array>;
} = {}) {
  const auditCalls: unknown[] = [];
  const artifactCalls: unknown[] = [];
  const storageCalls: Array<{ storageKey: string }> = [];
  return {
    auditCalls,
    artifactCalls,
    storageCalls,
    deps: {
      artifacts: {
        async create(input: Record<string, unknown>) {
          artifactCalls.push(input);
          return {
            ...input,
            artifactId: opts.artifactReturns?.artifactId ?? "a-1",
            id: 1,
            sourceArtifactId: null,
            createdAt: "now",
            updatedAt: "now",
            ...(opts.artifactReturns ?? {})
          } as never;
        }
      },
      storage: {
        async put(input: { storageKey: string; stream: NodeJS.ReadableStream }) {
          storageCalls.push({ storageKey: input.storageKey });
          if (opts.putThrows) throw new Error("storage put failed");
          // Drain the stream so the buffer is consumed
          for await (const _ of input.stream) {
            /* drained */
          }
          return {
            storageBackend: opts.putReturns?.storageBackend ?? "local",
            storageKey: opts.putReturns?.storageKey ?? input.storageKey,
            fileSizeBytes: opts.putReturns?.fileSizeBytes ?? 4,
            checksumSha256: opts.putReturns?.checksumSha256 ?? "stored-csum"
          };
        }
      },
      auditEvents: {
        async create(input: Record<string, unknown>) {
          auditCalls.push(input);
        }
      },
      readRuntimeFile: opts.readRuntimeFile
    }
  };
}

const tool = (deps: ReturnType<typeof makeDeps>["deps"]) =>
  createWriteArtifactTool(deps as Parameters<typeof createWriteArtifactTool>[0]).find(
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

test("write_artifact: rejects oversized content (> 10MB)", async () => {
  const huge = new Uint8Array(10_000_001);
  const { deps } = makeDeps({ readRuntimeFile: async () => huge });
  await expect(() => tool(deps).handler({ context: ctx(), arguments: { name: "x.bin", filePath: "./x" } })).rejects.toThrow(/File too large/);
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
  // Storage key looks like "<userId>/<sessionId>/<uuid>"
  // (no trailing extension since there was no dot)
  const key = storageCalls[0].storageKey;
  expect(key).toMatch(/^u\/s\/[a-f0-9-]+$/);
});

test("write_artifact: extension is sanitized of unsafe chars", async () => {
  const { deps, storageCalls } = makeDeps();
  await tool(deps).handler({
    context: ctx(),
    // Tricky filename with a leading dot in the "extension"
    arguments: { name: "weird.tar.g$", content: "x" }
  });
  // Only safe chars from the last segment after the final '.'
  const key = storageCalls[0].storageKey;
  expect(key).toMatch(/^u\/s\/[a-f0-9-]+\.g$/);
});
