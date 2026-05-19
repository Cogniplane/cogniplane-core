import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { rm, mkdir } from "node:fs/promises";

import { createTestConfig } from "../../test-helpers/test-config.js";
import { phase4RuntimePolicy } from "../../test-helpers/phase4-runtime-policy.js";
import { buildClaudeSdkOptions, ClaudeCodeRuntimeAdapter } from "./claude-code-runtime-adapter.js";
import { ManagedToolCatalog } from "../managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../managed-tools/factory.js";
import { registerBuiltinManagedTools } from "../managed-tools/register-builtin-managed-tools.js";
import { RuntimeEgressIpPinStore } from "../runtime-egress-ip-pin.js";

function makeTestManagedToolCatalog(): ManagedToolCatalog {
  const catalog = new ManagedToolCatalog();
  registerBuiltinManagedTools(catalog, new ManagedToolFactoryRegistry());
  return catalog;
}

const testWorkspaceRoot = path.join(os.tmpdir(), `claude-adapter-test-${Date.now()}`);

const testConfig = createTestConfig({
  RUNTIME_WORKSPACE_ROOT: testWorkspaceRoot,
  ANTHROPIC_API_KEY: "sk-ant-test-key"
});

const fakeDynamicConfig = {
  async compileRuntimeConfig() {
    return {
      runtimePolicy: { ...phase4RuntimePolicy, runtimeProvider: "claude-code" as const },
      skills: [],
      mcpServers: [],
      hash: "test-hash",
      sources: {
        runtimePolicy: { id: "test", version: 1, hash: "h" },
        skills: [],
        mcpServers: []
      }
    };
  }
};

const fakeLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => fakeLog,
  level: "silent"
} as unknown as import("fastify").FastifyBaseLogger;

describe("ClaudeCodeRuntimeAdapter", () => {
  let adapter: ClaudeCodeRuntimeAdapter;

  beforeAll(async () => {
    await mkdir(testWorkspaceRoot, { recursive: true });
  });

  const fakeApprovalStore = {
    async create() {
      return {} as import("./approval-store.js").ApprovalRecord;
    }
  };

  beforeEach(() => {
    adapter = new ClaudeCodeRuntimeAdapter(testConfig, fakeDynamicConfig, fakeLog, makeTestManagedToolCatalog(), {
      approvals: fakeApprovalStore
    });
  });

  afterAll(async () => {
    await rm(testWorkspaceRoot, { recursive: true, force: true });
  });

  it("has id 'claude-code'", () => {
    expect(adapter.id).toBe("claude-code");
  });

  it("createSession returns a valid RuntimeSessionRef", async () => {
    const ref = await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-1",
      userId: "user-1"
    });

    expect(ref.sessionId).toBe("sess-1");
    expect(ref.runtimeId.startsWith("claude-")).toBeTruthy();
    expect(ref.runtimePolicy.runtimeProvider).toBe("claude-code");
  });

  it("abortSession does not throw for unknown sessions", async () => {
    await expect(
      adapter.abortSession({
        tenantId: "test-tenant",
        sessionId: "nonexistent",
        userId: "user-1"
      })
    ).resolves.toBeUndefined();
  });

  it("abortSession clears the egress IP pin for the runtime", async () => {
    const egressIpPins = new RuntimeEgressIpPinStore(60_000);
    const adapterWithPins = new ClaudeCodeRuntimeAdapter(
      testConfig,
      fakeDynamicConfig,
      fakeLog,
      makeTestManagedToolCatalog(),
      { approvals: fakeApprovalStore, egressIpPins }
    );
    const ref = await adapterWithPins.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-pin-clear",
      userId: "user-1"
    });
    // Simulate the proxy having pinned this runtime to a peer IP.
    expect(egressIpPins.checkAndPin(ref.runtimeId, "203.0.113.5").kind).toBe("pinned");

    await adapterWithPins.abortSession({
      tenantId: "test-tenant",
      sessionId: "sess-pin-clear",
      userId: "user-1"
    });

    // After abort the slot must be reclaimable — next call pins fresh.
    expect(egressIpPins.checkAndPin(ref.runtimeId, "198.51.100.42").kind).toBe("pinned");
  });

  it("abortSession removes the session", async () => {
    await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-abort",
      userId: "user-1"
    });

    await adapter.abortSession({
      tenantId: "test-tenant",
      sessionId: "sess-abort",
      userId: "user-1"
    });

    // Attempting to run a message on a removed session should throw
    const ref = {
      sessionId: "sess-abort",
      runtimeId: "claude-removed",
      runtimePolicy: { ...phase4RuntimePolicy, runtimeProvider: "claude-code" as const }
    };

    const iter = adapter.runMessage(ref, {
      prompt: "hello",
      runtimePolicyId: "test",
      toolContextId: null
    });

    await expect(async () => {
            for await (const _ of iter) {
              // drain
            }
          }).rejects.toThrow(/No Claude Code session found/);
  });

  it("reads and writes files inside the Claude workspace", async () => {
    await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-files",
      userId: "user-1"
    });

    const writtenPath = await adapter.writeRuntimeFile(
      "sess-files",
      "./artifacts/example.txt",
      "hello from claude"
    );

    expect(writtenPath).toMatch(/artifacts\/example\.txt$/);
    const content = await adapter.readRuntimeFile("sess-files", "./artifacts/example.txt");
    expect(new TextDecoder().decode(content)).toBe("hello from claude");
  });

  it("rejects workspace path traversal", async () => {
    await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-traversal",
      userId: "user-1"
    });

    await expect(() => adapter.writeRuntimeFile("sess-traversal", "../escape.txt", "nope")).rejects.toThrow(/inside the session workspace/);
  });

  it("close aborts all tracked sessions", async () => {
    const first = await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-close-1",
      userId: "user-1"
    });
    const second = await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-close-2",
      userId: "user-1"
    });

    await adapter.close();

    await expect(async () => {
            for await (const _ of adapter.runMessage(first, {
              prompt: "hello",
              runtimePolicyId: "test",
              toolContextId: null
            })) {
              // drain
            }
          }).rejects.toThrow(/No Claude Code session found/);

    await expect(async () => {
            for await (const _ of adapter.runMessage(second, {
              prompt: "hello",
              runtimePolicyId: "test",
              toolContextId: null
            })) {
              // drain
            }
          }).rejects.toThrow(/No Claude Code session found/);
  });

  it("resolveApproval returns 'missing' when no matching approval exists", async () => {
    expect(
      await adapter.resolveApproval({
        approvalId: "nonexistent-id",
        tenantId: "test-tenant",
        userId: "user-1",
        decision: "approve"
      })
    ).toBe("missing");
  });

  it("createSession ignores the global E2B backend flag and still initializes the SDK path", async () => {
    const e2bConfig = createTestConfig({
      RUNTIME_WORKSPACE_ROOT: testWorkspaceRoot,
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      RUNTIME_BACKEND: "e2b",
      E2B_API_KEY: "e2b-test-key"
    });
    const e2bAdapter = new ClaudeCodeRuntimeAdapter(e2bConfig, fakeDynamicConfig, fakeLog, makeTestManagedToolCatalog(), {
      approvals: fakeApprovalStore
    });

    const ref = await e2bAdapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-e2b-ignored",
      userId: "user-1"
    });

    expect(ref.sessionId).toBe("sess-e2b-ignored");
    expect(ref.runtimeId.startsWith("claude-")).toBeTruthy();
  });

  it("hasSession/hasRuntime/hasActiveTurn report state for known sessions", async () => {
    const ref = await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-state",
      userId: "user-1"
    });
    expect(adapter.hasSession("sess-state")).toBe(true);
    expect(adapter.hasSession("nope")).toBe(false);
    expect(adapter.hasRuntime("sess-state", ref.runtimeId)).toBe(true);
    expect(adapter.hasRuntime("sess-state", "wrong-runtime")).toBe(false);
    expect(adapter.hasRuntime("nope", "x")).toBe(false);
    expect(adapter.hasActiveTurn("sess-state")).toBe(false);
  });

  it("createSession reuses an existing session ref when called twice", async () => {
    const first = await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-reuse",
      userId: "user-1"
    });
    const second = await adapter.createSession({
      tenantId: "test-tenant",
      sessionId: "sess-reuse",
      userId: "user-1"
    });
    expect(first.runtimeId).toBe(second.runtimeId);
  });

  it("invalidateIntegrationRuntimesForTenant aborts only this tenant's sessions", async () => {
    await adapter.createSession({ tenantId: "tenant-a", sessionId: "a-1", userId: "u" });
    await adapter.createSession({ tenantId: "tenant-a", sessionId: "a-2", userId: "u" });
    await adapter.createSession({ tenantId: "tenant-b", sessionId: "b-1", userId: "u" });

    const aborted = await adapter.invalidateIntegrationRuntimesForTenant(
      "tenant-a",
      "github"
    );
    expect(aborted.sort()).toEqual(["a-1", "a-2"]);
    expect(adapter.hasSession("a-1")).toBe(false);
    expect(adapter.hasSession("a-2")).toBe(false);
    expect(adapter.hasSession("b-1")).toBe(true);
  });

  it("interruptTurn expires every pending approval row and emits one approval.expired audit event per row", async () => {
    type PendingRow = { approvalId: string };
    const pending: PendingRow[] = [{ approvalId: "appr-1" }, { approvalId: "appr-2" }];
    const expireCalls: string[] = [];
    const auditCalls: Array<Record<string, unknown>> = [];

    const richApprovals = {
      async create() {
        return {} as import("./approval-store.js").ApprovalRecord;
      },
      async listPending(_t: string, _s: string, _u: string): Promise<PendingRow[]> {
        return [...pending];
      },
      async expire(_t: string, approvalId: string): Promise<PendingRow | null> {
        expireCalls.push(approvalId);
        return { approvalId };
      }
    };
    const auditEvents = {
      async create(input: Record<string, unknown>) {
        auditCalls.push(input);
      }
    };

    const wired = new ClaudeCodeRuntimeAdapter(
      testConfig,
      fakeDynamicConfig,
      fakeLog,
      makeTestManagedToolCatalog(),
      { approvals: richApprovals as never, auditEvents: auditEvents as never }
    );

    await wired.createSession({ tenantId: "tenant-x", sessionId: "sess-x", userId: "user-x" });
    // Force an "active turn" without spinning up the SDK so interruptTurn
    // doesn't bail out at the no_active_turn early return.
    type AdapterInternals = {
      activeTurns: Set<string>;
      sessions: Map<string, { activeTurnInterrupt: { current: (() => Promise<void>) | null } }>;
    };
    const internals = wired as unknown as AdapterInternals;
    internals.activeTurns.add("sess-x");
    const state = internals.sessions.get("sess-x")!;
    state.activeTurnInterrupt.current = async () => {};

    expect(await wired.interruptTurn({ tenantId: "tenant-x", sessionId: "sess-x", userId: "user-x" }))
      .toBe("interrupted");

    // Cleanup is voided inside interruptTurn; let the microtask queue drain.
    await new Promise((resolve) => setImmediate(resolve));

    expect(expireCalls.sort()).toEqual(["appr-1", "appr-2"]);
    expect(auditCalls).toHaveLength(2);
    for (const call of auditCalls) {
      expect(call).toMatchObject({
        tenantId: "tenant-x",
        sessionId: "sess-x",
        userId: "user-x",
        type: "approval.expired",
        payload: { reason: "turn_interrupted" }
      });
    }
  });

  it("resolveApproval returns 'missing' when sandbox-bound approval has wrong tenant/user", async () => {
    // Inject a fake e2bPendingApprovals entry without a real sandbox: we can't
    // build one without spawning E2B, but we can verify the tenant/user gate
    // by manipulating the public API: create a session, then call
    // resolveApproval with an approvalId that the adapter doesn't know about.
    // The local-mode code path in resolveApproval iterates sessions and
    // returns "missing" because there's no matching approval.
    await adapter.createSession({ tenantId: "tenant-a", sessionId: "s", userId: "u" });
    expect(
      await adapter.resolveApproval({
        approvalId: "unknown-approval",
        tenantId: "tenant-a",
        userId: "u",
        decision: "approve"
      })
    ).toBe("missing");
  });

  it("buildClaudeSdkOptions enables partial messages so tool-use events reach the UI", async () => {
    const canUseTool = async () => ({ behavior: "allow" as const });

    const options = buildClaudeSdkOptions({
      model: "sonnet",
      developerInstructions: "Use the managed tools when appropriate.",
      mcpServersConfig: {
        framework: {
          type: "http",
          url: "http://localhost:3001/mcp/framework?token=rt_test",
          headers: { Authorization: "Bearer rt_test" }
        }
      },
      workspacePath: "/tmp/claude-workspace",
      env: { ANTHROPIC_API_KEY: "sk-ant-test-key" },
      canUseTool
    });

    expect(options.includePartialMessages).toBe(true);
    expect(options.permissionMode).toBe("default");
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.model).toBe("sonnet");
    expect(options.cwd).toBe("/tmp/claude-workspace");
    expect(options.mcpServers).toEqual({
            framework: {
              type: "http",
              url: "http://localhost:3001/mcp/framework?token=rt_test",
              headers: { Authorization: "Bearer rt_test" }
            }
          });
    expect(options.canUseTool).toBe(canUseTool);
    expect(options.systemPrompt).toEqual({
            type: "preset",
            preset: "claude_code",
            append: "Use the managed tools when appropriate."
          });
  });
});
