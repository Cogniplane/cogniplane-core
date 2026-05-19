import { Readable } from "node:stream";
import { test, expect } from "vitest";

import type { ArtifactRecord } from "../artifacts/artifact-store.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";

import { createSessionTools } from "./session-tools.js";

function ctx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolContextId: "ctx-1",
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    runtimeId: "rt",
    runtimePolicyId: "default",
    messageId: null,
    credentialEnvelope: {},
    metadata: {},
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeArtifact(o: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 1,
    artifactId: "a1",
    sessionId: "s",
    userId: "u",
    artifactType: "upload",
    sourceArtifactId: null,
    artifactName: "f.txt",
    mimeType: "text/plain",
    storageBackend: "local",
    storageKey: "k1",
    fileSizeBytes: 4,
    checksumSha256: "x",
    status: "ready",
    createdByType: "user",
    createdByRef: null,
    detail: {},
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...o
  };
}

function findTool(deps: Parameters<typeof createSessionTools>[0], name: string) {
  return createSessionTools(deps).find((t) => t.name === name)!;
}

const baseDeps: Parameters<typeof createSessionTools>[0] = {
  sessions: {
    async getOwned() {
      return {
        sessionId: "s",
        sessionName: "Sess",
        status: "active"
      } as never;
    }
  },
  messages: { async listBySession() { return []; } },
  artifacts: {
    async getOwned() { return null; },
    async listBySession() { return []; },
    async findLatestReadableDerived() { return null; }
  },
  storage: {
    async openReadStream() {
      return { stream: Readable.from(["x"]) } as never;
    }
  }
};

// session_context

test("session_context throws when session is not found or not active", async () => {
  const deps = {
    ...baseDeps,
    sessions: { async getOwned() { return null; } }
  };
  const tool = findTool(deps, "session_context");
  await expect(() => tool.handler({ context: ctx(), arguments: {} })).rejects.toThrow(/Session not found/);
});

test("session_context throws when session is archived", async () => {
  const deps = {
    ...baseDeps,
    sessions: {
      async getOwned() {
        return { sessionId: "s", sessionName: "S", status: "archived" } as never;
      }
    }
  };
  const tool = findTool(deps, "session_context");
  await expect(() => tool.handler({ context: ctx(), arguments: {} })).rejects.toThrow();
});

test("session_context: clamps recentMessageCount and returns the trailing N messages", async () => {
  const allMessages = Array.from({ length: 6 }, (_, i) => ({
    role: "user",
    status: "completed",
    content: `m${i}`
  }));
  const deps = {
    ...baseDeps,
    messages: { async listBySession() { return allMessages as never; } }
  };
  const tool = findTool(deps, "session_context");
  const result = await tool.handler({
    context: ctx(),
    arguments: { recentMessageCount: 999 } // over-the-cap clamps to 10
  });
  // We only have 6 messages so all 6 are returned.
  const recentMessages = (result as { recentMessages: unknown[] }).recentMessages;
  expect(recentMessages.length).toBe(6);
});

test("session_context: invalid recentMessageCount falls back to 4", async () => {
  const all = Array.from({ length: 6 }, (_, i) => ({
    role: "user",
    status: "completed",
    content: String(i)
  }));
  const deps = {
    ...baseDeps,
    messages: { async listBySession() { return all as never; } }
  };
  const tool = findTool(deps, "session_context");
  const result = await tool.handler({
    context: ctx(),
    arguments: { recentMessageCount: "garbage" }
  });
  expect((result as { recentMessages: unknown[] }).recentMessages.length).toBe(4);
});

// list_artifacts

test("list_artifacts throws when session not active", async () => {
  const deps = {
    ...baseDeps,
    sessions: { async getOwned() { return null; } }
  };
  const tool = findTool(deps, "list_artifacts");
  await expect(() => tool.handler({ context: ctx(), arguments: {} })).rejects.toThrow();
});

test("list_artifacts: with no scope, returns all session artifacts mapped", async () => {
  const arts = [makeArtifact({ artifactId: "a" }), makeArtifact({ artifactId: "b" })];
  const deps = { ...baseDeps, artifacts: { ...baseDeps.artifacts, async listBySession() { return arts; } } };
  const tool = findTool(deps, "list_artifacts");
  const result = await tool.handler({ context: ctx(), arguments: {} });
  expect((result as { artifacts: unknown[] }).artifacts.length).toBe(2);
});

test("list_artifacts: with scope, filters down to scoped artifact ids", async () => {
  const arts = [
    makeArtifact({ artifactId: "a" }),
    makeArtifact({ artifactId: "b" }),
    makeArtifact({ artifactId: "c" })
  ];
  const deps = { ...baseDeps, artifacts: { ...baseDeps.artifacts, async listBySession() { return arts; } } };
  const tool = findTool(deps, "list_artifacts");
  const result = await tool.handler({
    context: ctx({ metadata: { selectedArtifactIds: ["a", "c"] } }),
    arguments: {}
  });
  const names = (result as { artifacts: { artifactId: string }[] }).artifacts.map((a) => a.artifactId);
  expect(names.sort()).toEqual(["a", "c"]);
});

test("list_artifacts: scope present but empty array → returns all (no filter)", async () => {
  const arts = [makeArtifact({ artifactId: "a" }), makeArtifact({ artifactId: "b" })];
  const deps = { ...baseDeps, artifacts: { ...baseDeps.artifacts, async listBySession() { return arts; } } };
  const tool = findTool(deps, "list_artifacts");
  const result = await tool.handler({
    context: ctx({ metadata: { selectedArtifactIds: [] } }),
    arguments: {}
  });
  expect((result as { artifacts: unknown[] }).artifacts.length).toBe(2);
});

test("list_artifacts: non-string entries in scope are dropped", async () => {
  const arts = [makeArtifact({ artifactId: "a" }), makeArtifact({ artifactId: "b" })];
  const deps = { ...baseDeps, artifacts: { ...baseDeps.artifacts, async listBySession() { return arts; } } };
  const tool = findTool(deps, "list_artifacts");
  const result = await tool.handler({
    context: ctx({ metadata: { selectedArtifactIds: ["a", 42] } }),
    arguments: {}
  });
  const names = (result as { artifacts: { artifactId: string }[] }).artifacts.map((a) => a.artifactId);
  expect(names).toEqual(["a"]);
});

// read_text_artifact

test("read_text_artifact requires artifactId", async () => {
  const tool = findTool(baseDeps, "read_text_artifact");
  await expect(() => tool.handler({ context: ctx(), arguments: {} })).rejects.toThrow(/artifactId is required/);
});

test("read_text_artifact: throws when artifact missing", async () => {
  const tool = findTool(baseDeps, "read_text_artifact");
  await expect(() => tool.handler({ context: ctx(), arguments: { artifactId: "x" } })).rejects.toThrow(/Artifact not found/);
});

test("read_text_artifact: throws when artifact belongs to a different session", async () => {
  const deps = {
    ...baseDeps,
    artifacts: {
      ...baseDeps.artifacts,
      async getOwned() {
        return makeArtifact({ sessionId: "other-session" });
      }
    }
  };
  const tool = findTool(deps, "read_text_artifact");
  await expect(() => tool.handler({ context: ctx(), arguments: { artifactId: "x" } })).rejects.toThrow();
});

test("read_text_artifact: throws when artifact is not in scoped set", async () => {
  const deps = {
    ...baseDeps,
    artifacts: {
      ...baseDeps.artifacts,
      async getOwned() {
        return makeArtifact({ artifactId: "z" });
      }
    }
  };
  const tool = findTool(deps, "read_text_artifact");
  await expect(() =>
        tool.handler({
          context: ctx({ metadata: { selectedArtifactIds: ["a", "b"] } }),
          arguments: { artifactId: "z" }
        })).rejects.toThrow(/outside the selected artifact scope/);
});

test("read_text_artifact: text mime returns content directly with truncated=false", async () => {
  const deps = {
    ...baseDeps,
    artifacts: {
      ...baseDeps.artifacts,
      async getOwned() {
        return makeArtifact({ artifactId: "z", mimeType: "text/plain", storageKey: "ks" });
      }
    },
    storage: {
      async openReadStream() {
        return { stream: Readable.from([Buffer.from("body")]) } as never;
      }
    }
  };
  const tool = findTool(deps, "read_text_artifact");
  const r = (await tool.handler({
    context: ctx(),
    arguments: { artifactId: "z" }
  })) as { content: string; truncated: boolean };
  expect(r.content).toBe("body");
  expect(r.truncated).toBe(false);
});

test("read_text_artifact: non-text mime falls back to derived readable artifact", async () => {
  const derived = makeArtifact({
    artifactId: "z-derived",
    mimeType: "text/plain",
    storageKey: "k-derived",
    sourceArtifactId: "z"
  });
  const deps = {
    ...baseDeps,
    artifacts: {
      ...baseDeps.artifacts,
      async getOwned() {
        return makeArtifact({
          artifactId: "z",
          mimeType: "application/pdf",
          storageKey: "k-pdf"
        });
      },
      async findLatestReadableDerived() {
        return derived;
      }
    },
    storage: {
      async openReadStream(key: string) {
        expect(key).toBe("k-derived");
        return { stream: Readable.from([Buffer.from("derived body")]) } as never;
      }
    }
  };
  const tool = findTool(deps, "read_text_artifact");
  const r = (await tool.handler({
    context: ctx(),
    arguments: { artifactId: "z" }
  })) as { content: string };
  expect(r.content).toBe("derived body");
});

test("read_text_artifact: non-text mime with no derived artifact throws", async () => {
  const deps = {
    ...baseDeps,
    artifacts: {
      ...baseDeps.artifacts,
      async getOwned() {
        return makeArtifact({ mimeType: "image/png" });
      }
    }
  };
  const tool = findTool(deps, "read_text_artifact");
  await expect(() => tool.handler({ context: ctx(), arguments: { artifactId: "x" } })).rejects.toThrow(/not a text-readable MIME type/);
});

test("read_text_artifact: maxChars=0 falls back to default 4000 (truthy fallback)", async () => {
  const deps = {
    ...baseDeps,
    artifacts: {
      ...baseDeps.artifacts,
      async getOwned() {
        return makeArtifact({ mimeType: "text/plain" });
      }
    },
    storage: {
      async openReadStream() {
        return { stream: Readable.from([Buffer.from("hello")]) } as never;
      }
    }
  };
  const tool = findTool(deps, "read_text_artifact");
  const r = (await tool.handler({
    context: ctx(),
    arguments: { artifactId: "x", maxChars: 0 }
  })) as { content: string; truncated: boolean };
  // maxChars=0 is falsy -> fallback 4000; full body fits
  expect(r.content).toBe("hello");
  expect(r.truncated).toBe(false);
});

test("read_text_artifact: caps maxChars at 20000 when given an absurd value", async () => {
  const deps = {
    ...baseDeps,
    artifacts: {
      ...baseDeps.artifacts,
      async getOwned() {
        return makeArtifact({ mimeType: "text/plain" });
      }
    },
    storage: {
      async openReadStream() {
        // Stream exactly 20,000 chars; if cap fails the test will see > 20_000
        return { stream: Readable.from([Buffer.from("a".repeat(20_001))]) } as never;
      }
    }
  };
  const tool = findTool(deps, "read_text_artifact");
  const r = (await tool.handler({
    context: ctx(),
    arguments: { artifactId: "x", maxChars: 999_999 }
  })) as { content: string; truncated: boolean };
  expect(r.content.length).toBe(20_000);
  expect(r.truncated).toBe(true);
});
