import { Readable } from "node:stream";
import { test, expect } from "vitest";

import { Pool } from "../../lib/db.js";
import { createFakeFetch } from "../../test-helpers/fake-fetch.js";
import { ManagedToolCatalog } from "./catalog.js";
import { ManagedToolFactoryRegistry, type ManagedToolFactoryDeps } from "./factory.js";
import { registerBuiltinManagedTools } from "./register-builtin-managed-tools.js";

const sharedCatalog = new ManagedToolCatalog();
const sharedFactoryRegistry = new ManagedToolFactoryRegistry();
registerBuiltinManagedTools(sharedCatalog, sharedFactoryRegistry);

const listManagedToolIds = (): string[] => sharedCatalog.listIds();
const createManagedToolDefinitions = sharedFactoryRegistry.createDefinitions.bind(sharedFactoryRegistry);
import type { ArtifactRecord, ArtifactStore } from "../artifacts/artifact-store.js";
import type { GithubRuntimeCredentials } from "../integrations/github/github-connection-service.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import type { ManagedToolDefinition } from "./types.js";

// ── In-memory fakes ──────────────────────────────────────────────────────────

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolContextId: "ctx-1",
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    runtimeId: "runtime-1",
    runtimePolicyId: "profile-1",
    messageId: "msg-1",
    credentialEnvelope: {},
    metadata: {},
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ...overrides
  };
}

class InMemoryStorage {
  readonly stored = new Map<string, Buffer>();
  readonly backend = "local" as const;

  async put(input: { storageKey: string; stream: Readable }) {
    const chunks: Buffer[] = [];
    for await (const chunk of input.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    this.stored.set(input.storageKey, buf);
    return {
      storageBackend: "local" as const,
      storageKey: input.storageKey,
      fileSizeBytes: buf.length,
      checksumSha256: "abc123"
    };
  }

  async openReadStream(storageKey: string) {
    const file = this.stored.get(storageKey);
    if (!file) throw new Error("not found");
    return { stream: Readable.from([file]), fileSizeBytes: file.length };
  }

  async delete(storageKey: string) {
    this.stored.delete(storageKey);
  }
}

function makeArtifactStore(): Pick<ArtifactStore, "create" | "createGenerated" | "getReadable" | "listBySession" | "findLatestReadableDerived"> & { created: Record<string, unknown>[] } {
  let counter = 0;
  const records: Record<string, unknown>[] = [];
  return {
    created: records,
    async create(input) {
      const record: ArtifactRecord = {
        artifactId: `artifact-${++counter}`,
        id: counter,
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      records.push({ ...record });
      return record;
    },
    async createGenerated(input) {
      return this.create(input);
    },
    async getReadable(_tenantId: string, _artifactId: string, _userId: string) { return null; },
    async listBySession(_tenantId: string, _sessionId: string, _userId: string) { return []; },
    async findLatestReadableDerived(_tenantId: string, _sourceArtifactId: string, _userId: string) { return null; }
  };
}

function makeSessionStore() {
  return {
    async getReadable() {
      return {
        sessionId: "session-1",
        sessionName: "test",
        status: "active" as const,
        userId: "user-1",
        createdAt: "",
        updatedAt: ""
      };
    }
  };
}

function makeMessageStore() {
  return { async listBySession() { return { messages: [], hasMore: false }; } };
}

function makeAuditEventStore() {
  return { created: [] as unknown[], async create(input: unknown) { (this.created as unknown[]).push(input); } };
}

function makeGithubConnections(creds: GithubRuntimeCredentials | null) {
  return {
    getRuntimeCredentials: async (_tenantId: string, _userId: string) => creds
  };
}

function makeNotionConnections() {
  return {
    getRuntimeCredentials: async (_tenantId: string, _userId: string) => null
  };
}

const unusedDb = new Pool();

function makeDeps(githubCreds: GithubRuntimeCredentials | null = null) {
  return {
    db: unusedDb,
    dynamicConfig: {
      async listSkills() { return []; }
    },
    sessions: makeSessionStore(),
    messages: makeMessageStore(),
    memories: {
      async search() { return []; },
      async save() { throw new Error("memory save should not be called"); },
      async remove() { return false; }
    },
    artifacts: makeArtifactStore(),
    storage: new InMemoryStorage(),
    auditEvents: makeAuditEventStore(),
    githubConnections: makeGithubConnections(githubCreds),
    notionConnections: makeNotionConnections(),
    artifactMaxBytes: 10_000_000,
    limits: {
      async consumeRateLimit() { return null; }
    },
    projectFiles: {
      async readRuntimeSnapshotFile() { throw new Error("project file read should not be called"); },
      async createAgentDraftFromContent() { throw new Error("project file write should not be called"); },
      async readConflictContext() { throw new Error("project conflict read should not be called"); },
      async readConflictMetadata() { throw new Error("project conflict metadata read should not be called"); }
    }
  } satisfies ManagedToolFactoryDeps;
}

function makeValidCreds(overrides: Partial<GithubRuntimeCredentials> = {}): GithubRuntimeCredentials {
  return {
    login: "octocat",
    name: "The Octocat",
    email: "octocat@github.com",
    token: "ghu_test_token",
    ...overrides
  };
}

function requireRecordField(
  record: Record<string, unknown> | null,
  field: string
): Record<string, unknown> {
  const value = record?.[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("github_read_file — returns file content when credentials valid", async () => {
  const tools = createManagedToolDefinitions(makeDeps(makeValidCreds()));
  const tool = tools.find((t) => t.name === "github_read_file")!;

  const fileData = {
    path: "src/index.ts",
    sha: "abc123",
    size: 42,
    encoding: "base64",
    content: Buffer.from("hello world", "utf-8").toString("base64") + "\n"
  };

  const fake = createFakeFetch(() => Response.json(fileData));

  try {
    const result = await tool.handler({
      context: makeContext(),
      arguments: { toolContextId: "ctx-1", repo: "org/repo", path: "src/index.ts" }
    });
    expect(result["content"]).toBe("hello world");
    expect(result["sha"]).toBe("abc123");
    expect(result["path"]).toBe("src/index.ts");
  } finally {
    fake.restore();
  }
});

test("managed tools expose output schemas for typed structured results", () => {
  const tools = createManagedToolDefinitions(makeDeps(makeValidCreds()));

  expect(tools.length).toBe(listManagedToolIds().length);
  for (const tool of tools) {
    expect(tool.outputSchema).toBeTruthy();
  }
});

test("github_read_file — returns error when no GitHub connection", async () => {
  const tools = createManagedToolDefinitions(makeDeps(null));
  const tool = tools.find((t) => t.name === "github_read_file")!;

  const result = await tool.handler({
    context: makeContext(),
    arguments: { toolContextId: "ctx-1", repo: "org/repo", path: "src/index.ts" }
  });

  expect(String(result["error"]).includes("No GitHub connection found")).toBeTruthy();
});

test("github_read_file — returns error on GitHub API 404", async () => {
  const tools = createManagedToolDefinitions(makeDeps(makeValidCreds()));
  const tool = tools.find((t) => t.name === "github_read_file")!;

  const fake = createFakeFetch(() => Response.json({ message: "Not Found" }, { status: 404 }));

  try {
    const result = await tool.handler({
      context: makeContext(),
      arguments: { toolContextId: "ctx-1", repo: "org/repo", path: "missing.ts" }
    });
    expect(String(result["error"]).includes("404")).toBeTruthy();
  } finally {
    fake.restore();
  }
});

test("github_write_file — returns commit info on success; uses creds.name/email for committer", async () => {
  const tools = createManagedToolDefinitions(makeDeps(makeValidCreds()));
  const tool = tools.find((t) => t.name === "github_write_file")!;

  let capturedBody: Record<string, unknown> | null = null;
  const responseData = {
    content: { path: "src/new.ts", sha: "def456" },
    commit: { sha: "ghi789", html_url: "https://github.com/org/repo/commit/ghi789", committer: { name: "The Octocat" } }
  };

  const fake = createFakeFetch((_url, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(responseData);
  });

  try {
    const result = await tool.handler({
      context: makeContext(),
      arguments: {
        toolContextId: "ctx-1",
        repo: "org/repo",
        path: "src/new.ts",
        branch: "main",
        content: "export const x = 1;",
        message: "add x"
      }
    });
    expect(result["sha"]).toBe("def456");
    expect(result["commitSha"]).toBe("ghi789");
    const committer = requireRecordField(capturedBody, "committer");
    expect(committer["name"]).toBe("The Octocat");
    expect(committer["email"]).toBe("octocat@github.com");
  } finally {
    fake.restore();
  }
});

test("github_write_file — falls back to login@users.noreply.github.com when email is null", async () => {
  const tools = createManagedToolDefinitions(makeDeps(makeValidCreds({ email: null })));
  const tool = tools.find((t) => t.name === "github_write_file")!;

  let capturedBody: Record<string, unknown> | null = null;
  const responseData = {
    content: { path: "src/new.ts", sha: "def456" },
    commit: { sha: "ghi789", html_url: "https://github.com/org/repo/commit/ghi789", committer: { name: "octocat" } }
  };

  const fake = createFakeFetch((_url, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(responseData);
  });

  try {
    await tool.handler({
      context: makeContext(),
      arguments: {
        toolContextId: "ctx-1",
        repo: "org/repo",
        path: "src/new.ts",
        branch: "main",
        content: "export const x = 1;",
        message: "add x"
      }
    });
    const committer = requireRecordField(capturedBody, "committer");
    expect(committer["email"]).toBe("octocat@users.noreply.github.com");
  } finally {
    fake.restore();
  }
});

test("github_create_pr — returns PR number and URL on success", async () => {
  const tools = createManagedToolDefinitions(makeDeps(makeValidCreds()));
  const tool = tools.find((t) => t.name === "github_create_pr")!;

  const responseData = {
    number: 42,
    html_url: "https://github.com/org/repo/pull/42",
    state: "open",
    title: "My PR",
    head: { ref: "feature-branch" },
    base: { ref: "main" },
    draft: false
  };

  const fake = createFakeFetch(() => Response.json(responseData));

  try {
    const result = await tool.handler({
      context: makeContext(),
      arguments: {
        toolContextId: "ctx-1",
        repo: "org/repo",
        title: "My PR",
        head: "feature-branch",
        base: "main"
      }
    });
    expect(result["number"]).toBe(42);
    expect(result["url"]).toBe("https://github.com/org/repo/pull/42");
    expect(result["head"]).toBe("feature-branch");
    expect(result["base"]).toBe("main");
  } finally {
    fake.restore();
  }
});

test("github_create_pr — returns error when no GitHub connection", async () => {
  const tools = createManagedToolDefinitions(makeDeps(null));
  const tool = tools.find((t) => t.name === "github_create_pr")!;

  const result = await tool.handler({
    context: makeContext(),
    arguments: {
      toolContextId: "ctx-1",
      repo: "org/repo",
      title: "My PR",
      head: "feature-branch",
      base: "main"
    }
  });

  expect(String(result["error"]).includes("No GitHub connection found")).toBeTruthy();
});

test("write_artifact creates artifact and stores content", async () => {
  const d = makeDeps();
  const tools = createManagedToolDefinitions(d);
  const tool = tools.find((t) => t.name === "write_artifact")!;

  const result = await tool.handler({
    context: makeContext(),
    arguments: {
      toolContextId: "ctx-1",
      name: "fibonacci.py",
      content: "print('hello')"
    }
  });

  expect(result["artifactName"]).toBe("fibonacci.py");
  expect(result["mimeType"]).toBe("text/x-python");
  expect(result["status"]).toBe("ready");
  expect(result["artifactId"]).toBeTruthy();

  // Verify content was stored
  expect(d.storage.stored.size).toBe(1);
  const storedContent = [...d.storage.stored.values()][0]!.toString("utf-8");
  expect(storedContent).toBe("print('hello')");

  // Verify audit event was created
  expect(d.auditEvents.created.length).toBe(1);
});

test("write_artifact infers MIME type from extension", async () => {
  const d = makeDeps();
  const tools = createManagedToolDefinitions(d);
  const tool = tools.find((t) => t.name === "write_artifact")!;

  const result = await tool.handler({
    context: makeContext(),
    arguments: { toolContextId: "ctx-1", name: "data.csv", content: "a,b\n1,2" }
  });
  expect(result["mimeType"]).toBe("text/csv");
});

test("write_artifact uses explicit mimeType when provided", async () => {
  const tools = createManagedToolDefinitions(makeDeps());
  const tool = tools.find((t) => t.name === "write_artifact")!;

  const result = await tool.handler({
    context: makeContext(),
    arguments: { toolContextId: "ctx-1", name: "output.dat", content: "data", mimeType: "application/octet-stream" }
  });
  expect(result["mimeType"]).toBe("application/octet-stream");
});

test("write_artifact rejects empty content", async () => {
  const tools = createManagedToolDefinitions(makeDeps());
  const tool = tools.find((t) => t.name === "write_artifact")!;

  await expect(() => tool.handler({
        context: makeContext(),
        arguments: { toolContextId: "ctx-1", name: "empty.txt", content: "" }
      })).rejects.toThrow(/Either content or filePath is required/);
});

test("write_artifact rejects an oversized filePath via stat WITHOUT reading the file", async () => {
  let readCalls = 0;
  const deps = {
    ...makeDeps(),
    readRuntimeFile: async () => {
      readCalls += 1;
      return new Uint8Array([1, 2, 3]);
    },
    statRuntimeFile: async () => ({ sizeBytes: 50_000_000 })
  };
  const tools = createManagedToolDefinitions(deps);
  const tool = tools.find((t) => t.name === "write_artifact")!;

  await expect(() => tool.handler({
        context: makeContext(),
        arguments: { toolContextId: "ctx-1", name: "huge.bin", filePath: "output/huge.bin" }
      })).rejects.toThrow(/File too large \(50000000 bytes\)/);
  // The whole point of the stat probe: the oversized file is never buffered.
  expect(readCalls).toBe(0);
});

test("write_artifact reads the file when the stat probe passes", async () => {
  const deps = {
    ...makeDeps(),
    readRuntimeFile: async () => new TextEncoder().encode("file body"),
    statRuntimeFile: async () => ({ sizeBytes: 9 })
  };
  const tools = createManagedToolDefinitions(deps);
  const tool = tools.find((t) => t.name === "write_artifact")!;

  const result = await tool.handler({
    context: makeContext(),
    arguments: { toolContextId: "ctx-1", name: "notes.txt", filePath: "output/notes.txt" }
  });
  expect(result["status"]).toBe("ready");
  expect(result["fileSizeBytes"]).toBe(9);
});

test("ManagedToolFactoryRegistry rejects duplicate factory keys", () => {
  const registry = new ManagedToolFactoryRegistry();
  const noop = () => [];
  registry.register("session", noop);
  expect(() => registry.register("session", noop)).toThrow(
    /already registered: session/
  );
});

// ── Policy Center category stamping ───────────────────────────────────────────
// createDefinitions stamps each produced tool's `category` to its factory domain
// key so the MCP gateway binds it to the right Policy Center category (consumed
// at routes/mcp.ts as `tool.category ?? serverId`). This is a security-relevant
// contract: a `categories` rule scoped to "github" must match github_read_file
// regardless of which managed-server URL the call arrived through.

test("createDefinitions stamps the factory domain key as the tool category", () => {
  const tools = createManagedToolDefinitions(makeDeps(makeValidCreds()));

  const githubReadFile = tools.find((t) => t.name === "github_read_file")!;
  expect(githubReadFile.category).toBe("github");

  const sessionContext = tools.find((t) => t.name === "session_context")!;
  expect(sessionContext.category).toBe("session");
});

test("createDefinitions preserves a category a factory set on its own definition", () => {
  const registry = new ManagedToolFactoryRegistry();
  const stubTool = (name: string, category?: string): ManagedToolDefinition => ({
    name,
    description: name,
    readOnly: true,
    inputSchema: {},
    category,
    handler: async () => ({})
  });

  // Registered under domain key "github", but the factory pins its own category.
  registry.register("github", () => [stubTool("github_explicit", "custom-domain")]);
  // A sibling def with no category falls back to the domain key.
  registry.register("session", () => [stubTool("session_default")]);

  const defs = registry.createDefinitions(makeDeps());

  expect(defs.find((d) => d.name === "github_explicit")!.category).toBe("custom-domain");
  expect(defs.find((d) => d.name === "session_default")!.category).toBe("session");
});
