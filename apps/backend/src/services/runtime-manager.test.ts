import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, onTestFinished } from "vitest";

import type { FastifyBaseLogger } from "fastify";

import codexRelease from "../codex-release.json" with { type: "json" };
import { CodexRuntimeProcessStartError } from "./runtime/codex-jsonrpc.js";
import type { DynamicConfigService } from "./dynamic-config-service.js";
import { CodexRuntimeManager, resolveInsideSandbox } from "./runtime-manager.js";
import type { ApprovalRecord } from "./auth/approval-store.js";
import type { RuntimeSessionUpsertInput } from "./runtime/runtime-session-store.js";
import type { WorkspaceArtifacts } from "./runtime/runtime-workspace.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { phase4RuntimePolicy } from "../test-helpers/phase4-runtime-policy.js";

type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcRequest = {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

class FakeRuntimeProcess {
  readonly port = 4123;
  readonly pid = 9876;
  readonly requestLog: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly notificationLog: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly responseLog: Array<{ id: number | string; result?: unknown; error?: unknown }> = [];
  alive = true;
  skillListResponse: unknown = {
    data: [
      {
        cwd: "/tmp/cogniplane-runtime-tests/test-user/session-1",
        errors: [],
        skills: [
          {
            name: "pdf-processing",
            path: "/tmp/cogniplane-runtime-tests/test-user/session-1/.codex/skills/pdf-processing",
            enabled: true,
            scope: "admin"
          }
        ]
      }
    ]
  };

  // When set, `turn/start` records into requestLog immediately but blocks on
  // this gate before returning a turnId. Lets a test reproduce the window where
  // the active turn exists with a still-null responseId (a fast Stop click).
  turnStartGate: Promise<void> | null = null;

  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly requestListeners = new Set<(request: JsonRpcRequest) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  isAlive(): boolean {
    return this.alive;
  }

  async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.requestLog.push({ method, params });

    if (method === "turn/start" && this.turnStartGate) {
      await this.turnStartGate;
    }

    if (method === "initialize") {
      return {} as T;
    }

    if (method === "thread/start") {
      return {
        thread: {
          id: "thread-1"
        }
      } as T;
    }

    if (method === "turn/start") {
      return {
        turn: {
          id: "turn-1"
        }
      } as T;
    }

    if (method === "skills/list") {
      return this.skillListResponse as T;
    }

    if (method === "skills/config/write") {
      return {} as T;
    }

    if (method === "turn/interrupt") {
      return {} as T;
    }

    throw new Error(`Unexpected request method in test: ${method}`);
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    this.notificationLog.push({ method, params });
  }

  sendResponse(id: number | string, result: unknown): void {
    this.responseLog.push({ id, result });
  }

  sendError(id: number | string, code: number, message: string): void {
    this.responseLog.push({
      id,
      error: {
        code,
        message
      }
    });
  }

  terminate(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const listener of this.closeListeners) {
      listener();
    }
    for (const listener of this.exitListeners) {
      listener(null, null);
    }
  }

  rejectPendingRequests(): void {}

  onNotification(listener: (notification: JsonRpcNotification) => void): void {
    this.notificationListeners.add(listener);
  }

  onRequest(listener: (request: JsonRpcRequest) => void): void {
    this.requestListeners.add(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.add(listener);
  }

  emitNotification(notification: JsonRpcNotification): void {
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }

  emitClose(): void {
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  emitRequest(request: JsonRpcRequest): void {
    for (const listener of this.requestListeners) {
      listener(request);
    }
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      listener(code, signal);
    }
  }
}

class InMemoryRuntimeSessionStore {
  readonly upserts: RuntimeSessionUpsertInput[] = [];
  readonly statusUpdates: Array<{ tenantId: string; sessionId: string; userId: string; status: string }> = [];

  async upsert(input: RuntimeSessionUpsertInput) {
    this.upserts.push(input);
    return {
      id: this.upserts.length,
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeId: input.runtimeId,
      runtimeProvider: input.runtimeProvider ?? "codex",
      workspacePath: input.workspacePath,
      runtimeVersion: input.runtimeVersion,
      runtimeSchemaVersion: input.runtimeSchemaVersion,
      manifestPath: input.manifestPath,
      manifestMetadata: input.manifestMetadata,
      healthStatus: input.healthStatus,
      lastActiveAt: input.lastActiveAt,
      startedAt: input.startedAt,
      terminatedAt: input.terminatedAt,
      lifecycleMetadata: input.lifecycleMetadata,
      status: input.status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async setStatus(tenantId: string, sessionId: string, userId: string, status: string) {
    this.statusUpdates.push({ tenantId, sessionId, userId, status });
    return null;
  }
}

class NoopApprovalStore {
  async create(): Promise<ApprovalRecord> {
    return {
      approvalId: "approval-1",
      sessionId: "session-1",
      userId: "test-user",
      runtimeId: "runtime-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      requestMethod: "item/commandExecution/requestApproval",
      requestId: "1",
      kind: "command_execution",
      title: "Approve shell command",
      summary: "pwd",
      status: "pending",
      decision: null,
      requestPayload: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null
    };
  }

  async resolve(): Promise<ApprovalRecord> {
    return {
      approvalId: "approval-1",
      sessionId: "session-1",
      userId: "test-user",
      runtimeId: "runtime-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      requestMethod: "item/commandExecution/requestApproval",
      requestId: "1",
      kind: "command_execution",
      title: "Approve shell command",
      summary: "pwd",
      status: "approved",
      decision: "approve",
      requestPayload: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString()
    };
  }

  async expire(): Promise<ApprovalRecord | null> {
    return null;
  }
}

class RecordingApprovalStore {
  readonly created: ApprovalRecord[] = [];
  // Number of times resolve() was called. The cross-provider guard test relies
  // on this staying at 0: the Codex manager must bail out (returning "missing")
  // before touching a row it does not own.
  resolveCount = 0;

  async create(input: Omit<ApprovalRecord, "createdAt" | "updatedAt" | "resolvedAt"> & { tenantId: string }): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null
    };
    this.created.push(record);
    return record;
  }

  // cancelPendingApprovals enumerates pending rows via this method. Mirror the
  // real store's contract: only rows that are still `pending` (not yet expired
  // or resolved) for the given tenant/session/user are returned.
  async listPending(tenantId: string, sessionId: string, userId: string): Promise<ApprovalRecord[]> {
    return this.created.filter(
      (a) =>
        a.tenantId === tenantId &&
        a.sessionId === sessionId &&
        a.userId === userId &&
        !this.expired.includes(a.approvalId) &&
        a.status === "pending"
    );
  }

  async resolve(
    _tenantId: string,
    approvalId: string,
    userId: string,
    decision: "approve" | "reject"
  ): Promise<ApprovalRecord> {
    this.resolveCount += 1;
    const existing = this.created.find(
      (approval) => approval.approvalId === approvalId && approval.userId === userId
    );

    // Guard misuse at the fake's boundary rather than asserting inside it: the
    // store contract is that resolve() only ever runs against a previously
    // created approval. Throwing (instead of expect()) keeps `existing`
    // narrowed to a defined ApprovalRecord, so the spread below is type-safe.
    if (!existing) {
      throw new Error(
        `RecordingApprovalStore.resolve called for unknown approval ${approvalId} / user ${userId}`
      );
    }

    return {
      ...existing,
      status: decision === "approve" ? "approved" : "rejected",
      decision,
      updatedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString()
    };
  }

  readonly expired: string[] = [];
  async expire(_tenantId: string, approvalId: string): Promise<ApprovalRecord | null> {
    const existing = this.created.find((a) => a.approvalId === approvalId);
    if (!existing) return null;
    this.expired.push(approvalId);
    return {
      ...existing,
      status: "expired",
      decision: null,
      updatedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString()
    };
  }
}

class NoopToolEventStore {
  async create() {}
}

const noopArtifacts: Pick<import("./artifact-store.js").ArtifactStore, "create" | "listBySession"> = {
  async create() { return {} as never; },
  async listBySession() { return []; }
};

const noopStorage: Pick<import("./artifact-storage.js").ArtifactStorage, "put"> = {
  async put() { return {} as never; }
};

const noopSkillBundleStorage: import("./skills/skill-bundle-storage.js").SkillBundleStorage = {
  backend: "local",
  async storeBundle() { return { storageUri: "file:///noop" }; },
  async installBundle() {},
  async materializeBundle() { return { localPath: "/noop" }; },
  async deleteBundle() {}
};

const testConfig = createTestConfig({
  RUNTIME_WORKSPACE_ROOT: "/tmp/cogniplane-runtime-tests"
});

const runtimeConfig = {
  runtimePolicy: {
    ...phase4RuntimePolicy,
    description: null
  },
  skills: [
    {
      id: "pdf-processing",
      name: "PDF processing",
      description: null,
      instructions: "Use the bundle.",
      version: 3,
      hash: "hash-pdf-processing",
      revisionId: 11,
      bundleHash: "hash-pdf-processing-bundle",
      sourceType: "github",
      bundleName: "pdf-processing",
      bundleStorageUri: "file:///tmp/cogniplane-runtime-tests/test-user/session-1/.codex/skills/pdf-processing",
      validationStatus: "validated",
      reviewStatus: "active"
    }
  ],
  mcpServers: [] as Array<{
    id: string;
    description: string;
    mode: "managed" | "proxy";
    routePath: string;
    upstreamUrl: string | null;
    transportKind: "http";
    headersAllowlist: string[];
    version: number;
    hash: string;
  }>,
  hash: "hash-config-bundle",
  sources: {
    runtimePolicy: {
      id: "tenant-settings:test-tenant",
      version: 1,
      hash: "hash-phase4-tools"
    },
    skills: [
      {
        id: "pdf-processing",
        version: 3,
        hash: "hash-pdf-processing",
        revisionId: 11,
        bundleHash: "hash-pdf-processing-bundle"
      }
    ],
    mcpServers: []
  }
};

const dynamicConfig: Pick<
  DynamicConfigService,
  "getRuntimePolicy" | "compileRuntimeConfig"
> = {
  async getRuntimePolicy(_tenantId: string) {
    return runtimeConfig.runtimePolicy;
  },
  async compileRuntimeConfig(_tenantId: string) {
    return runtimeConfig;
  }
};

const workspaceArtifacts: WorkspaceArtifacts = {
  workspacePath: "/tmp/cogniplane-runtime-tests/test-user/session-1",
  codexTomlPath: "/tmp/cogniplane-runtime-tests/test-user/session-1/codex.toml",
  manifestPath: "/tmp/cogniplane-runtime-tests/test-user/session-1/.framework/runtime-manifest.json",
  runtimeToken: "rt_test-token.test-signature",
  manifest: {
    manifestVersion: "cogniplane.runtime-manifest.v1",
    manifestHash: "hash-runtime-manifest",
    configBundleHash: runtimeConfig.hash,
    sessionId: "session-1",
    userId: "test-user",
    generatedAt: "2026-03-15T00:00:00.000Z",
    workspacePath: "/tmp/cogniplane-runtime-tests/test-user/session-1",
    codex: {
      binaryPath: "codex",
      version: codexRelease.codexVersion,
      schemaVersion: codexRelease.schemaVersion,
      model: "gpt-5.4"
    },
    runtimePolicy: {
      id: "tenant-settings:test-tenant",
      version: 1,
      hash: "hash-phase4-tools",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      networkMode: "restricted",
      allowCommandExecution: true,
      allowUserTokenForwarding: true,
      autoApproveReadOnlyTools: true,
      enabledToolIds: runtimeConfig.runtimePolicy.enabledToolIds
    },
    skills: [
      {
        id: "pdf-processing",
        name: "PDF processing",
        version: 3,
        hash: "hash-pdf-processing",
        revisionId: 11,
        bundleHash: "hash-pdf-processing-bundle",
        path: "/tmp/cogniplane-runtime-tests/test-user/session-1/.codex/skills/pdf-processing",
        sourceType: "github"
      }
    ],
    mcpServers: [],
    configSources: runtimeConfig.sources,
    config: {
      codexTomlPath: "/tmp/cogniplane-runtime-tests/test-user/session-1/codex.toml",
      skillsPath: "/tmp/cogniplane-runtime-tests/test-user/session-1/.codex/skills",
      customSkillsEnabled: false,
      customMcpServersEnabled: false
    }
  }
};

function createLogger(): FastifyBaseLogger {
  const noop = () => {};
  return {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => createLogger(),
    level: "silent"
  } as FastifyBaseLogger;
}

async function collectEvents(iterable: AsyncIterable<unknown>) {
  const result = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

// Consume the turn stream into `events` while exposing a promise that resolves
// the moment the first event matching `predicate` is observed. Used by the
// interrupt tests to wait deterministically until `response.created` has been
// emitted — i.e. the turn's responseId is assigned — before calling
// interruptTurn (which refuses while the turnId is still null). Avoids racing
// the orchestrator's post-`turn/start` microtask.
function collectEventsUntil(
  iterable: AsyncIterable<unknown>,
  predicate: (event: unknown) => boolean
): { events: unknown[]; done: Promise<unknown[]>; reached: Promise<void> } {
  const events: unknown[] = [];
  let signalReached: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });

  const done = (async () => {
    for await (const item of iterable) {
      events.push(item);
      if (predicate(item)) {
        signalReached();
      }
    }
    signalReached();
    return events;
  })();

  return { events, done, reached };
}

function isResponseCreated(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: string }).type === "response.created"
  );
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  assertion();
}

test("resolveInsideSandbox: returns relative paths joined to the workspace root", () => {
  expect(resolveInsideSandbox("/home/user/workspace", "out.txt")).toBe(
    "/home/user/workspace/out.txt"
  );
});

test("resolveInsideSandbox: normalizes . and .. segments while staying inside root", () => {
  expect(resolveInsideSandbox("/home/user/ws", "./a/b/../c.txt")).toBe(
    "/home/user/ws/a/c.txt"
  );
});

test("resolveInsideSandbox: keeps absolute paths that are already inside root", () => {
  expect(resolveInsideSandbox("/home/user/ws", "/home/user/ws/inner/file.md")).toBe(
    "/home/user/ws/inner/file.md"
  );
});

test("resolveInsideSandbox: rejects relative traversal that escapes root", () => {
  expect(() => resolveInsideSandbox("/home/user/ws", "../etc/passwd")).toThrow(
    /must be inside the session workspace/
  );
});

test("resolveInsideSandbox: rejects absolute paths outside root", () => {
  expect(() => resolveInsideSandbox("/home/user/ws", "/etc/passwd")).toThrow(
    /must be inside the session workspace/
  );
});

test("resolveInsideSandbox: allows the workspace root itself", () => {
  expect(resolveInsideSandbox("/home/user/ws", ".")).toBe("/home/user/ws");
});

test("resolveInsideSandbox: handles workspace paths with trailing slash", () => {
  expect(resolveInsideSandbox("/home/user/ws/", "x.txt")).toBe("/home/user/ws/x.txt");
});

test("initializes the pinned protocol and starts a thread before the session becomes active", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const process = new FakeRuntimeProcess();
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  const session = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  expect(session).toEqual({
        sessionId: "session-1",
        runtimeId: runtimeSessions.upserts.at(-1)?.runtimeId,
        runtimePolicy: {
          id: runtimeConfig.runtimePolicy.id,
          label: runtimeConfig.runtimePolicy.label,
          description: runtimeConfig.runtimePolicy.description,
          runtimeProvider: runtimeConfig.runtimePolicy.runtimeProvider,
          approvalPolicy: runtimeConfig.runtimePolicy.approvalPolicy,
          sandboxMode: runtimeConfig.runtimePolicy.sandboxMode,
          networkMode: runtimeConfig.runtimePolicy.networkMode,
          allowCommandExecution: runtimeConfig.runtimePolicy.allowCommandExecution,
          allowUserTokenForwarding: runtimeConfig.runtimePolicy.allowUserTokenForwarding,
          autoApproveReadOnlyTools: runtimeConfig.runtimePolicy.autoApproveReadOnlyTools,
          developerInstructions: runtimeConfig.runtimePolicy.developerInstructions,
          approvalReviewer: runtimeConfig.runtimePolicy.approvalReviewer,
          enabledToolIds: runtimeConfig.runtimePolicy.enabledToolIds,
          enabledMcpServers: runtimeConfig.runtimePolicy.enabledMcpServers,
          version: runtimeConfig.runtimePolicy.version,
          hash: runtimeConfig.runtimePolicy.hash
        }
      });
  // Assert the handshake by relative ordering + presence, not an exact array.
  // The contract is "initialize before thread/start before skills config write
  // before skills list" — a benign extra probe (e.g. a capability check) the
  // app-server may add later should not fail this test.
  const handshakeMethods = process.requestLog.map((entry) => entry.method);
  expect(handshakeMethods).toContain("initialize");
  expect(handshakeMethods).toContain("thread/start");
  expect(handshakeMethods).toContain("skills/config/write");
  expect(handshakeMethods).toContain("skills/list");
  expect(handshakeMethods.indexOf("initialize")).toBeLessThan(handshakeMethods.indexOf("thread/start"));
  expect(handshakeMethods.indexOf("thread/start")).toBeLessThan(handshakeMethods.indexOf("skills/config/write"));
  expect(handshakeMethods.indexOf("skills/config/write")).toBeLessThan(handshakeMethods.indexOf("skills/list"));
  expect(process.notificationLog.length).toBe(1);
  expect(process.notificationLog[0].method).toBe("initialized");
  expect(runtimeSessions.upserts.length).toBe(2);
  expect(runtimeSessions.upserts[0].status).toBe("starting");
  expect(runtimeSessions.upserts[1].status).toBe("active");
  expect(runtimeSessions.upserts[1].healthStatus).toBe("healthy");
  expect(manager.getHealthSnapshot().activeRuntimeCount).toEqual(1);
  const threadStartRequest = process.requestLog.find((entry) => entry.method === "thread/start");
  expect((threadStartRequest?.params as { approvalPolicy?: string }).approvalPolicy).toBe("on-request");
  expect((runtimeSessions.upserts[1].lifecycleMetadata as { discoveredSkillNames?: string[] })
          .discoveredSkillNames?.[0]).toBe("pdf-processing");
});

test("fails startup when installed bundle skills are not discoverable", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const process = new FakeRuntimeProcess();
  process.skillListResponse = {
    data: [
      {
        cwd: "/tmp/cogniplane-runtime-tests/test-user/session-1",
        errors: [],
        skills: []
      }
    ]
  };
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  await expect(manager.createSession({
        tenantId: "test-tenant",
        sessionId: "session-1",
        userId: "test-user"
      })).rejects.toThrow(/not discoverable through Codex/);

  expect(runtimeSessions.upserts.length).toBe(2);
  expect(runtimeSessions.upserts[1].status).toBe("error");
  expect(String((runtimeSessions.upserts[1].lifecycleMetadata as { lastError?: string }).lastError)).toMatch(/not discoverable through Codex/);
});

test("bootstraps github git credentials into the runtime workspace when a user connection exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-github-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const process = new FakeRuntimeProcess();
  let capturedEnv: Record<string, string> | undefined;
  let capturedLocalWorkspacePath: string | undefined;
  const localWorkspacePath = path.join(root, "local-stage", "session-1");
  const sessionWorkspace: WorkspaceArtifacts = {
    ...workspaceArtifacts,
    workspacePath: "/home/user/workspace/session-1",
    localWorkspacePath,
    codexTomlPath: "/home/user/workspace/session-1/codex.toml",
    manifestPath: "/home/user/workspace/session-1/.framework/runtime-manifest.json",
    manifest: {
      ...workspaceArtifacts.manifest,
      workspacePath: "/home/user/workspace/session-1",
      config: {
        ...workspaceArtifacts.manifest.config,
        codexTomlPath: "/home/user/workspace/session-1/codex.toml",
        skillsPath: "/home/user/workspace/session-1/.codex/skills"
      }
    }
  };

  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    githubConnections: {
      async getRuntimeCredentials() {
        return {
          login: "octocat",
          name: "The Octocat",
          email: "octocat@example.com",
          token: "github-token-123",
          source: "user" as const
        };
      }
    },
    workspaceFactory: async () => sessionWorkspace,
    processFactory: async (input) => {
      capturedEnv = input.env;
      capturedLocalWorkspacePath = input.localWorkspacePath;
      return process;
    }
  });

  await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  expect(capturedEnv?.GH_TOKEN).toBe("github-token-123");
  expect(capturedEnv?.GITHUB_TOKEN).toBe("github-token-123");
  expect(capturedEnv?.EAF_GITHUB_TOKEN).toBe("github-token-123");
  expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBe("0");
  expect(capturedLocalWorkspacePath).toBe(localWorkspacePath);
  expect(capturedEnv?.GIT_CONFIG_GLOBAL).toBeTruthy();

  const gitConfig = await readFile(String(capturedEnv?.GIT_CONFIG_GLOBAL), "utf8");
  expect(gitConfig).toMatch(/\[credential\]/);
  expect(gitConfig).toMatch(/octocat@example\.com/);

  const helperScript = await readFile(
    path.join(localWorkspacePath, ".sandbox", "github", "git-credential-helper.sh"),
    "utf8"
  );
  expect(helperScript).toMatch(/x-access-token/);
});

// The sandbox never receives the real OpenAI key: when ANY key (tenant or
// backend) is configured, the sandbox env's OPENAI_API_KEY is the session's
// short-lived rt_* runtime token, and Codex is pointed at the /llm/openai
// proxy which swaps it for the real key on the backend.
test("passes the rt_* runtime token (not the real key) when a backend key is configured", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const runtimeProcess = new FakeRuntimeProcess();
  let capturedEnv: Record<string, string> | undefined;
  const manager = new CodexRuntimeManager({
    config: createTestConfig({ OPENAI_API_KEY: "backend-openai-key" }),
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    getTenantApiKey: async () => null,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async (input) => {
      capturedEnv = input.env;
      return runtimeProcess;
    }
  });

  await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  expect(capturedEnv?.OPENAI_API_KEY).toBe(workspaceArtifacts.runtimeToken);
  expect(capturedEnv?.OPENAI_API_KEY).not.toBe("backend-openai-key");
});

test("passes the rt_* runtime token when a tenant key is configured", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const runtimeProcess = new FakeRuntimeProcess();
  let capturedEnv: Record<string, string> | undefined;
  const manager = new CodexRuntimeManager({
    config: createTestConfig({ OPENAI_API_KEY: "backend-openai-key" }),
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    getTenantApiKey: async () => "tenant-openai-key",
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async (input) => {
      capturedEnv = input.env;
      return runtimeProcess;
    }
  });

  await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  expect(capturedEnv?.OPENAI_API_KEY).toBe(workspaceArtifacts.runtimeToken);
  expect(capturedEnv?.OPENAI_API_KEY).not.toBe("tenant-openai-key");
});

test("maps turn start and streaming notifications into framework response events", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const process = new FakeRuntimeProcess();
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  const session = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const eventsPromise = collectEvents(
    manager.runMessage(session, {
      prompt: "Say hello",
      runtimePolicyId: "phase4-tools",
      toolContextId: "ctx-test"
    })
  );

  await waitFor(() => {
    expect(process.requestLog.some((entry) => entry.method === "turn/start")).toBeTruthy();
  });

  process.emitNotification({
    method: "item/agentMessage/delta",
    params: { delta: "Hello" }
  });
  process.emitNotification({
    method: "item/completed",
    params: { item: { type: "agentMessage" } }
  });
  process.emitNotification({
    method: "turn/completed",
    params: { turn: { status: "completed" } }
  });

  const events = await eventsPromise;

  expect(events).toEqual([
        { type: "response.created", responseId: "turn-1" },
        { type: "response.output_text.delta", responseId: "turn-1", delta: "Hello" },
        { type: "response.output_item.done", responseId: "turn-1" },
        { type: "response.completed", responseId: "turn-1" }
      ]);
  expect(runtimeSessions.upserts.at(-1)?.status).toBe("active");
});

test("translates execCommandApproval requests into pending approvals and resumes on approval", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const approvals = new RecordingApprovalStore();
  const process = new FakeRuntimeProcess();
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals,
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  const session = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const eventsPromise = collectEvents(
    manager.runMessage(session, {
      prompt: "Compute Fibonacci numbers",
      runtimePolicyId: "phase4-tools",
      toolContextId: "ctx-test"
    })
  );

  await waitFor(() => {
    expect(process.requestLog.some((entry) => entry.method === "turn/start")).toBeTruthy();
  });

  process.emitRequest({
    id: 42,
    method: "execCommandApproval",
    params: {
      conversationId: "thread-1",
      callId: "call-1",
      approvalId: "approval-1",
      command: ["python", "fib.py"],
      cwd: "/tmp/cogniplane-runtime-tests",
      reason: "Need to run a helper script",
      parsedCmd: []
    }
  });

  await waitFor(() => {
    expect(approvals.created.length).toBe(1);
  });

  await manager.resolveApproval({
    tenantId: "test-tenant",
    approvalId: "approval-1",
    userId: "test-user",
    decision: "approve"
  });

  process.emitNotification({
    method: "turn/completed",
    params: { turn: { status: "completed" } }
  });

  const events = await eventsPromise;

  expect(events).toEqual([
        { type: "response.created", responseId: "turn-1" },
        {
          type: "framework:approval_required",
          responseId: "turn-1",
          approvalId: "approval-1",
          itemId: "call-1",
          kind: "command_execution",
          title: "Approve shell command",
          summary: "python fib.py\ncwd: /tmp/cogniplane-runtime-tests\nNeed to run a helper script",
          availableDecisions: ["approve", "reject"],
          command: "python fib.py",
          cwd: "/tmp/cogniplane-runtime-tests"
        },
        { type: "response.output_item.done", responseId: "turn-1" },
        { type: "response.completed", responseId: "turn-1" }
      ]);
  expect(process.responseLog.at(-1)).toEqual({
        id: 42,
        result: {
          decision: "approved"
        }
      });
});

test("approval expires after TTL: rejects to runtime, marks DB row, emits warning notice", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const approvals = new RecordingApprovalStore();
  const auditEvents = new InMemoryAuditEventStore();
  const process = new FakeRuntimeProcess();
  const manager = new CodexRuntimeManager({
    config: createTestConfig({ APPROVAL_REQUEST_TTL_MS: 25 }),
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals,
    auditEvents,
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  const session = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const eventsPromise = collectEvents(
    manager.runMessage(session, {
      prompt: "Run a thing",
      runtimePolicyId: "phase4-tools",
      toolContextId: "ctx-test"
    })
  );

  await waitFor(() => {
    expect(process.requestLog.some((entry) => entry.method === "turn/start")).toBeTruthy();
  });

  process.emitRequest({
    id: 99,
    method: "execCommandApproval",
    params: {
      conversationId: "thread-1",
      callId: "call-99",
      approvalId: "approval-99",
      command: ["sleep", "1000"],
      cwd: "/tmp",
      reason: "expiry test"
    }
  });

  await waitFor(() => {
    expect(approvals.created.length).toBe(1);
  });

  // Wait for the TTL to fire and the runtime to be unblocked.
  await waitFor(() => {
    expect(approvals.expired.includes("approval-99")).toBeTruthy();
    expect(process.responseLog.some((entry) => entry.id === 99 && entry.result?.decision === "denied")).toBeTruthy();
  });

  // The turn never completed naturally — close the runtime to terminate the stream.
  process.emitNotification({
    method: "turn/completed",
    params: { turn: { status: "completed" } }
  });

  const events = await eventsPromise;

  const notice = events.find(
    (event): event is { type: "framework:runtime_notice"; noticeId: string; level: string } & Record<string, unknown> =>
      typeof event === "object" &&
      event !== null &&
      (event as { type?: string }).type === "framework:runtime_notice"
  );
  expect(notice).toBeTruthy();
  expect(String(notice.noticeId)).toMatch(/^approval-expired:approval-99$/);
  expect(notice.level).toBe("warning");

  const expiredAudit = auditEvents.events.find((e) => e.type === "approval.expired");
  expect(expiredAudit).toBeTruthy();
  expect(expiredAudit.approvalId).toBe("approval-99");
});

test("persists startup failures with pinned runtime metadata", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      throw new CodexRuntimeProcessStartError("Codex startup failed", 4444, 99);
    }
  });

  await expect(manager.createSession({
        tenantId: "test-tenant",
        sessionId: "session-1",
        userId: "test-user"
      })).rejects.toThrow(/Codex startup failed/);

  expect(runtimeSessions.upserts.length).toBe(1);
  expect(runtimeSessions.upserts[0].status).toBe("error");
  expect(runtimeSessions.upserts[0].healthStatus).toBe("error");
  expect(runtimeSessions.upserts[0].runtimeVersion).toBe(codexRelease.codexVersion);
  expect(runtimeSessions.upserts[0].runtimeSchemaVersion).toBe(codexRelease.schemaVersion);
  expect(runtimeSessions.upserts[0].lifecycleMetadata.lastError).toBe("Codex startup failed");
});

test("reuses an in-flight startup for concurrent session creation", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  let processFactoryCalls = 0;
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      processFactoryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new FakeRuntimeProcess();
    }
  });

  const [first, second] = await Promise.all([
    manager.createSession({
      tenantId: "test-tenant",
      sessionId: "session-1",
      userId: "test-user"
    }),
    manager.createSession({
      tenantId: "test-tenant",
      sessionId: "session-1",
      userId: "test-user"
    })
  ]);

  expect(processFactoryCalls).toBe(1);
  expect(first).toEqual(second);

  await manager.close();
});

test("old runtime shutdown does not overwrite a replacement runtime row", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const processes: FakeRuntimeProcess[] = [];
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      const process = new FakeRuntimeProcess();
      processes.push(process);
      return process;
    }
  });

  await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });
  await manager.abortSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const replacement = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  expect(processes.length).toBe(2);

  processes[0].emitExit(0, null);

  await waitFor(() => {
    expect(runtimeSessions.upserts.at(-1)?.runtimeId).toBe(replacement.runtimeId);
    expect(runtimeSessions.upserts.at(-1)?.status).toBe("active");
    expect(runtimeSessions.upserts.at(-1)?.healthStatus).toBe("healthy");
  });

  await manager.close();
});

test("refresh_idle drains idle runtimes so the next session start gets a fresh runtime", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-runtime-refresh-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const workspaces: WorkspaceArtifacts[] = [
    {
      ...workspaceArtifacts,
      workspacePath: path.join(root, "session-1"),
      codexTomlPath: path.join(root, "session-1", "codex.toml"),
      manifestPath: path.join(root, "session-1", ".framework", "runtime-manifest.json"),
      manifest: {
        ...workspaceArtifacts.manifest,
        workspacePath: path.join(root, "session-1"),
        mcpServers: [
          {
            id: "managed-session-context",
            version: 1,
            hash: "hash-managed-session-context",
            mode: "managed",
            url: "http://127.0.0.1:3001/mcp/managed-session-context"
          }
        ],
        config: {
          ...workspaceArtifacts.manifest.config,
          codexTomlPath: path.join(root, "session-1", "codex.toml")
        }
      }
    },
    {
      ...workspaceArtifacts,
      workspacePath: path.join(root, "session-1"),
      codexTomlPath: path.join(root, "session-1", "codex.toml"),
      manifestPath: path.join(root, "session-1", ".framework", "runtime-manifest.json"),
      manifest: {
        ...workspaceArtifacts.manifest,
        workspacePath: path.join(root, "session-1"),
        mcpServers: [
          {
            id: "managed-session-context",
            version: 2,
            hash: "hash-managed-session-context-2",
            mode: "managed",
            url: "http://127.0.0.1:3001/mcp/managed-session-context"
          }
        ],
        config: {
          ...workspaceArtifacts.manifest.config,
          codexTomlPath: path.join(root, "session-1", "codex.toml")
        }
      }
    }
  ];
  let workspaceIndex = 0;
  const processes: FakeRuntimeProcess[] = [];

  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => {
      const workspace = workspaces[Math.min(workspaceIndex, workspaces.length - 1)];
      workspaceIndex += 1;
      await mkdir(path.dirname(workspace.codexTomlPath), { recursive: true });
      await writeFile(
        workspace.codexTomlPath,
        "[mcp_servers.managed-session-context]\nurl = \"http://127.0.0.1:3001/mcp/managed-session-context\"\n"
      );
      return workspace;
    },
    processFactory: async () => {
      const process = new FakeRuntimeProcess();
      processes.push(process);
      return process;
    }
  });

  const first = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });
  const affectedSessionIds = await manager.refreshIdleRuntimes("test-tenant", "refresh_idle");
  const second = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  expect(affectedSessionIds).toEqual(["session-1"]);
  expect(first.runtimeId).not.toBe(second.runtimeId);
  expect(processes.length).toBe(2);
  expect(processes[0].alive).toBe(false);
  expect(runtimeSessions.upserts.at(-1)?.runtimeId).toBe(second.runtimeId);
  expect(runtimeSessions.upserts.at(-1)?.status).toBe("active");

  await manager.close();
});

test("refreshIdleRuntimes is tenant-scoped — leaves other tenants' idle runtimes alone", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const processes: FakeRuntimeProcess[] = [];
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      const process = new FakeRuntimeProcess();
      processes.push(process);
      return process;
    }
  });

  // Pin each process to its tenant by capturing the array length at the
  // moment of creation. Avoids coupling assertions to insertion-order indexes.
  const beforeA = processes.length;
  const tenantA = await manager.createSession({
    tenantId: "tenant-a",
    sessionId: "session-a",
    userId: "user-a"
  });
  const tenantAProcess = processes[beforeA];

  const beforeB = processes.length;
  const tenantB = await manager.createSession({
    tenantId: "tenant-b",
    sessionId: "session-b",
    userId: "user-b"
  });
  const tenantBProcess = processes[beforeB];

  expect(tenantAProcess.alive).toBe(true);
  expect(tenantBProcess.alive).toBe(true);
  expect(tenantA.runtimeId).not.toBe(tenantB.runtimeId);

  const affected = await manager.refreshIdleRuntimes("tenant-a", "refresh_idle");

  // Only tenant-a's session is reported; tenant-b is intentionally absent.
  expect(affected).toEqual(["session-a"]);
  expect(affected).not.toContain("session-b");
  expect(tenantAProcess.alive).toBe(false);
  expect(tenantBProcess.alive).toBe(true);

  // Re-creating tenant-a's session yields a fresh runtime (proves the old
  // one was actually drained, not just flagged). Re-creating tenant-b's
  // session reuses the existing live runtime (proves the rollout never
  // touched it).
  const tenantARecreated = await manager.createSession({
    tenantId: "tenant-a",
    sessionId: "session-a",
    userId: "user-a"
  });
  const tenantBReused = await manager.createSession({
    tenantId: "tenant-b",
    sessionId: "session-b",
    userId: "user-b"
  });

  expect(tenantARecreated.runtimeId).not.toBe(tenantA.runtimeId);
  expect(tenantBReused.runtimeId).toBe(tenantB.runtimeId);
  expect(processes.length).toBe(3);

  await manager.close();
});

test("invalidateRuntimesForIntegration (github) restarts an active runtime for that user", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const processes: FakeRuntimeProcess[] = [];
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      const process = new FakeRuntimeProcess();
      processes.push(process);
      return process;
    }
  });

  const first = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const invalidatedSessionIds = await manager.invalidateRuntimesForIntegration(
    "test-tenant",
    "test-user",
    "github"
  );
  const second = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  expect(invalidatedSessionIds).toEqual(["session-1"]);
  expect(first.runtimeId).not.toBe(second.runtimeId);
  expect(processes.length).toBe(2);
  expect(processes[0].alive).toBe(false);
  expect(runtimeSessions.upserts.at(-1)?.runtimeId).toBe(second.runtimeId);
  expect(runtimeSessions.upserts.at(-1)?.status).toBe("active");

  await manager.close();
});

test("invalidateRuntimesForIntegration (github) restarts an in-flight startup before it is returned", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const processes: FakeRuntimeProcess[] = [];
  let processFactoryCalls = 0;
  let releaseFirstStart: (() => void) | null = null;
  const firstStartGate = new Promise<void>((resolve) => {
    releaseFirstStart = resolve;
  });
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      processFactoryCalls += 1;
      if (processFactoryCalls === 1) {
        await firstStartGate;
      }

      const process = new FakeRuntimeProcess();
      processes.push(process);
      return process;
    }
  });

  const sessionPromise = manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  await waitFor(() => {
    expect(processFactoryCalls).toBe(1);
  });

  const invalidatedSessionIds = await manager.invalidateRuntimesForIntegration(
    "test-tenant",
    "test-user",
    "github"
  );
  releaseFirstStart?.();

  const session = await sessionPromise;

  expect(invalidatedSessionIds).toEqual(["session-1"]);
  expect(processFactoryCalls).toBe(2);
  expect(processes.length).toBe(2);
  expect(processes[0].alive).toBe(false);
  expect(runtimeSessions.upserts.at(-1)?.runtimeId).toBe(session.runtimeId);
  expect(runtimeSessions.upserts.at(-1)?.status).toBe("active");

  await manager.close();
});

test("invalidateRuntimesForIntegration (github) leaves the same userId in a different tenant untouched", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const processes: FakeRuntimeProcess[] = [];
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      const process = new FakeRuntimeProcess();
      processes.push(process);
      return process;
    }
  });

  // Same userId in two tenants. Invalidation must be tenant-scoped — a
  // github reconnect in tenant-a should not disturb the live runtime in
  // tenant-b even though the same user owns both.
  const tenantA = await manager.createSession({
    tenantId: "tenant-a",
    sessionId: "session-a",
    userId: "shared-user"
  });
  const tenantB = await manager.createSession({
    tenantId: "tenant-b",
    sessionId: "session-b",
    userId: "shared-user"
  });

  const invalidatedSessionIds = await manager.invalidateRuntimesForIntegration(
    "tenant-a",
    "shared-user",
    "github"
  );

  expect(invalidatedSessionIds).toEqual(["session-a"]);
  expect(processes.length).toBe(2);
  // Process for tenant-a's session is dead; tenant-b's is still alive.
  expect(processes[0].alive).toBe(false);
  expect(processes[1].alive).toBe(true);

  // Re-creating tenant-b's session returns the original runtime — proof the
  // invalidation never touched it.
  const tenantBReused = await manager.createSession({
    tenantId: "tenant-b",
    sessionId: "session-b",
    userId: "shared-user"
  });
  expect(tenantBReused.runtimeId).toBe(tenantB.runtimeId);
  // And re-creating tenant-a's session returns a fresh runtime.
  const tenantARecreated = await manager.createSession({
    tenantId: "tenant-a",
    sessionId: "session-a",
    userId: "shared-user"
  });
  expect(tenantARecreated.runtimeId).not.toBe(tenantA.runtimeId);

  await manager.close();
});

test("invalidateIntegrationRuntimesForTenant restarts every active runtime in the tenant", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const processes: FakeRuntimeProcess[] = [];
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      const process = new FakeRuntimeProcess();
      processes.push(process);
      return process;
    }
  });

  const firstA = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-a",
    userId: "user-a"
  });
  const firstB = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-b",
    userId: "user-b"
  });

  const invalidated = await manager.invalidateIntegrationRuntimesForTenant("test-tenant", "notion");

  const secondA = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-a",
    userId: "user-a"
  });
  const secondB = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-b",
    userId: "user-b"
  });

  expect(invalidated.sort()).toEqual(["session-a", "session-b"]);
  expect(firstA.runtimeId).not.toBe(secondA.runtimeId);
  expect(firstB.runtimeId).not.toBe(secondB.runtimeId);
  expect(processes.length).toBe(4);
  expect(processes[0].alive).toBe(false);
  expect(processes[1].alive).toBe(false);

  await manager.close();
});

test("invalidateIntegrationRuntimesForTenant ignores other tenants", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const processes: FakeRuntimeProcess[] = [];
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => {
      const process = new FakeRuntimeProcess();
      processes.push(process);
      return process;
    }
  });

  await manager.createSession({
    tenantId: "tenant-a",
    sessionId: "session-a",
    userId: "user-a"
  });
  await manager.createSession({
    tenantId: "tenant-b",
    sessionId: "session-b",
    userId: "user-b"
  });

  const invalidated = await manager.invalidateIntegrationRuntimesForTenant("tenant-a", "github");

  expect(invalidated).toEqual(["session-a"]);
  // Tenant-b runtime survived.
  expect(processes[1].alive).toBe(true);

  await manager.close();
});

test("interruptTurn: stops the active turn, emits a terminal interrupted frame, and issues exactly one turn/interrupt", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const process = new FakeRuntimeProcess();
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  const session = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const collected = collectEventsUntil(
    manager.runMessage(session, {
      prompt: "Long-running thing",
      runtimePolicyId: "phase4-tools",
      toolContextId: "ctx-test"
    }),
    isResponseCreated
  );

  // The turn must be fully started (turnId assigned via response.created) before
  // interruptTurn will act — otherwise it refuses (see the "before turn/start"
  // test below).
  await collected.reached;

  const outcome = await manager.interruptTurn({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const events = await collected.done;

  expect(outcome).toBe("interrupted");
  // Terminal frame carries the interrupted flag so the writer persists partial
  // output under the "interrupted" status.
  expect(events.at(-1)).toEqual({
    type: "response.completed",
    responseId: "turn-1",
    interrupted: true
  });
  // Exactly one turn/interrupt — no double-send, no retry storm.
  const interruptRequests = process.requestLog.filter((entry) => entry.method === "turn/interrupt");
  expect(interruptRequests.length).toBe(1);
  expect(interruptRequests[0].params).toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
  // The runtime process stays alive so the user can immediately send a follow-up.
  expect(process.alive).toBe(true);

  await manager.close();
});

test("interruptTurn: refuses to interrupt before turn/start assigns a turnId — no turn/interrupt issued", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const process = new FakeRuntimeProcess();

  // Gate turn/start so the active turn exists (queued by runMessage) but its
  // responseId is still null when interruptTurn runs. This reproduces a fast
  // Stop click that lands before Codex returns a turnId.
  let releaseTurnStart: (() => void) | null = null;
  process.turnStartGate = new Promise<void>((resolve) => {
    releaseTurnStart = resolve;
  });

  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals: new NoopApprovalStore(),
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  const session = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const collected = collectEventsUntil(
    manager.runMessage(session, {
      prompt: "Race the Stop button",
      runtimePolicyId: "phase4-tools",
      toolContextId: "ctx-test"
    }),
    isResponseCreated
  );

  // Wait until turn/start is in-flight (gated) so the active turn exists with a
  // null responseId. turn/start is recorded into requestLog *before* the gate
  // awaits, so seeing it here guarantees the gated, responseId-less window.
  await waitFor(() => {
    expect(process.requestLog.some((entry) => entry.method === "turn/start")).toBeTruthy();
  });

  const outcome = await manager.interruptTurn({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  expect(outcome).toBe("no_active_turn");
  // No turn/interrupt was sent — interrupting here would orphan the running turn.
  expect(process.requestLog.some((entry) => entry.method === "turn/interrupt")).toBe(false);

  // Let the gated turn proceed and complete so the stream terminates cleanly.
  releaseTurnStart?.();
  await collected.reached;
  process.emitNotification({
    method: "turn/completed",
    params: { turn: { status: "completed" } }
  });
  await collected.done;

  await manager.close();
});

test("interruptTurn: clears a still-pending approval — rejects it to the runtime and drops the DB row", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const approvals = new RecordingApprovalStore();
  const auditEvents = new InMemoryAuditEventStore();
  const process = new FakeRuntimeProcess();
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals,
    auditEvents,
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  const session = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const collected = collectEventsUntil(
    manager.runMessage(session, {
      prompt: "Do a thing that needs approval",
      runtimePolicyId: "phase4-tools",
      toolContextId: "ctx-test"
    }),
    isResponseCreated
  );

  await collected.reached;

  process.emitRequest({
    id: 77,
    method: "execCommandApproval",
    params: {
      conversationId: "thread-1",
      callId: "call-77",
      approvalId: "approval-77",
      command: ["rm", "-rf", "/tmp/x"],
      cwd: "/tmp",
      reason: "interrupt-while-pending"
    }
  });

  await waitFor(() => {
    expect(approvals.created.length).toBe(1);
  });

  const outcome = await manager.interruptTurn({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });
  expect(outcome).toBe("interrupted");

  // cancelPendingApprovals is fire-and-forget: wait for its observable effects.
  // 1. The runtime is unblocked with a reject ("denied" for the compat method).
  // 2. The DB row is expired (dropped from pending).
  await waitFor(() => {
    expect(
      process.responseLog.some(
        (entry) => entry.id === 77 && (entry.result as { decision?: string } | undefined)?.decision === "denied"
      )
    ).toBeTruthy();
    expect(approvals.expired).toContain("approval-77");
  });

  // The pending row is gone, so resolving it now reports "missing" — proof the
  // in-memory entry and timer were cleared, not just the DB row.
  const lateResolve = await manager.resolveApproval({
    tenantId: "test-tenant",
    approvalId: "approval-77",
    userId: "test-user",
    decision: "approve"
  });
  expect(lateResolve).toBe("missing");

  const events = await collected.done;
  expect(events.at(-1)).toEqual({
    type: "response.completed",
    responseId: "turn-1",
    interrupted: true
  });

  await manager.close();
});

test("resolveApproval: returns 'missing' without touching the row when no in-memory runtime owns it (Claude-owned guard)", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const approvals = new RecordingApprovalStore();
  const process = new FakeRuntimeProcess();
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals,
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  // This approval id was never registered with any Codex runtime (it belongs to
  // a Claude runtime in production). The Codex manager must NOT flip the shared
  // DB row — the production route tries the Claude resolver next.
  const outcome = await manager.resolveApproval({
    tenantId: "test-tenant",
    approvalId: "claude-owned-approval",
    userId: "test-user",
    decision: "approve"
  });

  expect(outcome).toBe("missing");
  expect(approvals.resolveCount).toBe(0);

  await manager.close();
});

test("resolveApproval: rememberForTurn auto-approves the next same-kind request with no new approval row", async () => {
  const runtimeSessions = new InMemoryRuntimeSessionStore();
  const approvals = new RecordingApprovalStore();
  const process = new FakeRuntimeProcess();
  const manager = new CodexRuntimeManager({
    config: testConfig,
    dynamicConfig,
    logger: createLogger(),
    runtimeSessions,
    approvals,
    auditEvents: new InMemoryAuditEventStore(),
    toolEvents: new NoopToolEventStore(),
    artifacts: noopArtifacts,
    storage: noopStorage,
    skillBundleStorage: noopSkillBundleStorage,
    workspaceFactory: async () => workspaceArtifacts,
    processFactory: async () => process
  });

  const session = await manager.createSession({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "test-user"
  });

  const eventsPromise = collectEvents(
    manager.runMessage(session, {
      prompt: "Run two shell commands",
      runtimePolicyId: "phase4-tools",
      toolContextId: "ctx-test"
    })
  );

  await waitFor(() => {
    expect(process.requestLog.some((entry) => entry.method === "turn/start")).toBeTruthy();
  });

  // First command-execution approval — surfaced to the user.
  process.emitRequest({
    id: 10,
    method: "execCommandApproval",
    params: {
      conversationId: "thread-1",
      callId: "call-10",
      approvalId: "approval-10",
      command: ["ls"],
      cwd: "/tmp",
      reason: "first"
    }
  });

  await waitFor(() => {
    expect(approvals.created.length).toBe(1);
  });

  const firstOutcome = await manager.resolveApproval({
    tenantId: "test-tenant",
    approvalId: "approval-10",
    userId: "test-user",
    decision: "approve",
    rememberForTurn: true
  });
  expect(firstOutcome).toBe("resolved");

  // Second command-execution approval (same kind). Because rememberForTurn
  // recorded the kind, it must auto-approve WITHOUT creating a second DB row.
  process.emitRequest({
    id: 11,
    method: "execCommandApproval",
    params: {
      conversationId: "thread-1",
      callId: "call-11",
      approvalId: "approval-11",
      command: ["pwd"],
      cwd: "/tmp",
      reason: "second"
    }
  });

  // Observable signal: the runtime is auto-approved (compat method → "approved")
  // for request id 11, and no new approval row was created.
  await waitFor(() => {
    expect(
      process.responseLog.some(
        (entry) => entry.id === 11 && (entry.result as { decision?: string } | undefined)?.decision === "approved"
      )
    ).toBeTruthy();
  });
  expect(approvals.created.length).toBe(1);
  expect(approvals.created.some((row) => row.approvalId === "approval-11")).toBe(false);

  process.emitNotification({
    method: "turn/completed",
    params: { turn: { status: "completed" } }
  });
  await eventsPromise;

  await manager.close();
});
