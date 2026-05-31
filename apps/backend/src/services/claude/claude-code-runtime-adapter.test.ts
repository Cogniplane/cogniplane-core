import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
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
import { E2bClaudeRuntimeProcess } from "../runtime/e2b-claude-runtime-process.js";

function makeTestManagedToolCatalog(): ManagedToolCatalog {
  const catalog = new ManagedToolCatalog();
  registerBuiltinManagedTools(catalog, new ManagedToolFactoryRegistry());
  return catalog;
}

/**
 * Minimal stand-in for E2bClaudeRuntimeProcess. Covers every method the
 * adapter + bootstrap invoke on `state.e2bProcess`:
 *   - bootstrap: sendWarmup
 *   - createSession reuse / abort: isAlive, terminate
 *   - readRuntimeFile / writeRuntimeFile: readFile, writeFile (round-trips
 *     content keyed by sandbox path so the read-back assertion holds)
 *   - resolveApproval (e2b path): sendApprovalResponse (a vi.fn so tests can
 *     assert the forwarded decision)
 * A fresh instance is minted per E2bClaudeRuntimeProcess.start() call so
 * sessions don't share file state.
 */
function makeFakeE2bProcess() {
  const files = new Map<string, Uint8Array>();
  return {
    isAlive: () => true,
    terminate: vi.fn(async () => {}),
    sendWarmup: vi.fn(async () => {}),
    sendApprovalResponse: vi.fn(async () => {}),
    readFile: async (sandboxPath: string): Promise<Uint8Array> => {
      const stored = files.get(sandboxPath);
      if (!stored) throw new Error(`no such file: ${sandboxPath}`);
      return stored;
    },
    writeFile: async (sandboxPath: string, data: string | Uint8Array | ArrayBuffer): Promise<void> => {
      let bytes: Uint8Array;
      if (typeof data === "string") {
        bytes = new TextEncoder().encode(data);
      } else if (data instanceof Uint8Array) {
        bytes = data;
      } else {
        bytes = new Uint8Array(data);
      }
      files.set(sandboxPath, bytes);
    }
  };
}

const testWorkspaceRoot = path.join(os.tmpdir(), `claude-adapter-test-${Date.now()}`);

const testConfig = createTestConfig({
  RUNTIME_WORKSPACE_ROOT: testWorkspaceRoot,
  ANTHROPIC_API_KEY: "sk-ant-test-key"
});

// E2B is the only Claude backend, so every adapter needs real e2bOptions and a
// stubbed sandbox start (see beforeEach) to construct sessions without spawning
// a real sandbox.
const testE2bOptions = { apiKey: "e2b-test-key", templateId: "tpl-test", sandboxTimeoutMs: 1_800_000 };

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

  beforeEach(() => {
    // Stub the static sandbox bootstrap so createSession never spawns a real
    // E2B sandbox. A fresh fake per call keeps file/approval state isolated.
    vi.spyOn(E2bClaudeRuntimeProcess, "start").mockImplementation(
      async () => makeFakeE2bProcess() as unknown as E2bClaudeRuntimeProcess
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fakeApprovalStore = {
    async create() {
      return {} as import("./approval-store.js").ApprovalRecord;
    },
    // No matching pending row by default — the atomic guard returns null, so
    // resolveApproval surfaces "missing" without touching the live runtime.
    async resolve() {
      return null;
    }
  };

  beforeEach(() => {
    adapter = new ClaudeCodeRuntimeAdapter(
      testConfig,
      fakeDynamicConfig,
      fakeLog,
      makeTestManagedToolCatalog(),
      { approvals: fakeApprovalStore },
      undefined,
      testE2bOptions
    );
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
      { approvals: fakeApprovalStore, egressIpPins },
      undefined,
      testE2bOptions
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
      { approvals: richApprovals as never, auditEvents: auditEvents as never },
      undefined,
      testE2bOptions
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
    // Seed a pending e2b approval owned by tenant-a/u, then attempt to resolve
    // it as a different user. forwardApprovalDecision's tenant/user gate must
    // reject without flipping the DB row or forwarding to the sandbox.
    await adapter.createSession({ tenantId: "tenant-a", sessionId: "s", userId: "u" });
    (adapter as unknown as { e2bPendingApprovals: Map<string, string> }).e2bPendingApprovals.set(
      "appr-mismatch",
      "s"
    );
    expect(
      await adapter.resolveApproval({
        approvalId: "appr-mismatch",
        tenantId: "tenant-a",
        userId: "someone-else",
        decision: "approve"
      })
    ).toBe("missing");
  });

  it("resolveApproval flips the DB row, forwards the decision to the sandbox, and emits an audit event", async () => {
    type ResolveArgs = { tenantId: string; approvalId: string; userId: string; decision: string };
    const resolveCalls: ResolveArgs[] = [];
    const auditCalls: Array<Record<string, unknown>> = [];

    const richApprovals = {
      async create() {
        return {} as import("./approval-store.js").ApprovalRecord;
      },
      async resolve(tenantId: string, approvalId: string, userId: string, decision: string) {
        resolveCalls.push({ tenantId, approvalId, userId, decision });
        return {
          approvalId,
          sessionId: "sess-approve",
          userId,
          itemId: "item-9",
          kind: "command_execution"
        } as unknown as import("./approval-store.js").ApprovalRecord;
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
      { approvals: richApprovals as never, auditEvents: auditEvents as never },
      undefined,
      testE2bOptions
    );

    await wired.createSession({ tenantId: "tenant-a", sessionId: "sess-approve", userId: "user-1" });

    // Seed a pending e2b approval mapping approvalId → sessionId. The real
    // canUseTool Promise lives inside the sandbox harness, so the adapter
    // forwards the decision over the bridge (state.e2bProcess.sendApprovalResponse).
    const approvalId = "appr-1";
    (wired as unknown as { e2bPendingApprovals: Map<string, string> }).e2bPendingApprovals.set(
      approvalId,
      "sess-approve"
    );
    const sandboxProcess = (wired as unknown as {
      sessions: Map<string, { e2bProcess: { sendApprovalResponse: ReturnType<typeof vi.fn> } }>;
    }).sessions.get("sess-approve")!.e2bProcess;

    const result = await wired.resolveApproval({
      approvalId,
      tenantId: "tenant-a",
      userId: "user-1",
      decision: "approve"
    });

    expect(result).toBe("resolved");
    // DB row flipped exactly once, with the decision threaded through.
    expect(resolveCalls).toEqual([
      { tenantId: "tenant-a", approvalId, userId: "user-1", decision: "approve" }
    ]);
    // Audit event mirrors the Codex payload shape.
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      tenantId: "tenant-a",
      sessionId: "sess-approve",
      userId: "user-1",
      approvalId,
      type: "approval.approved",
      payload: { itemId: "item-9", kind: "command_execution" }
    });
    // The decision was forwarded to the in-sandbox harness as "approve".
    expect(sandboxProcess.sendApprovalResponse).toHaveBeenCalledWith(approvalId, "approve");
  });

  it("resolveApproval emits approval.rejected and forwards a reject to the sandbox", async () => {
    const auditCalls: Array<Record<string, unknown>> = [];
    const richApprovals = {
      async create() {
        return {} as import("./approval-store.js").ApprovalRecord;
      },
      async resolve(_t: string, approvalId: string, userId: string) {
        return {
          approvalId,
          sessionId: "sess-reject",
          userId,
          itemId: "item-r",
          kind: "file_change"
        } as unknown as import("./approval-store.js").ApprovalRecord;
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
      { approvals: richApprovals as never, auditEvents: auditEvents as never },
      undefined,
      testE2bOptions
    );
    await wired.createSession({ tenantId: "tenant-a", sessionId: "sess-reject", userId: "user-1" });

    const approvalId = "appr-r";
    (wired as unknown as { e2bPendingApprovals: Map<string, string> }).e2bPendingApprovals.set(
      approvalId,
      "sess-reject"
    );
    const sandboxProcess = (wired as unknown as {
      sessions: Map<string, { e2bProcess: { sendApprovalResponse: ReturnType<typeof vi.fn> } }>;
    }).sessions.get("sess-reject")!.e2bProcess;

    const result = await wired.resolveApproval({
      approvalId,
      tenantId: "tenant-a",
      userId: "user-1",
      decision: "reject"
    });

    expect(result).toBe("resolved");
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      type: "approval.rejected",
      payload: { itemId: "item-r", kind: "file_change" }
    });
    // The decision was forwarded to the in-sandbox harness as "reject".
    expect(sandboxProcess.sendApprovalResponse).toHaveBeenCalledWith(approvalId, "reject");
  });

  it("resolveApproval returns 'missing' without auditing when the DB row is not pending", async () => {
    const auditCalls: unknown[] = [];
    const richApprovals = {
      async create() {
        return {} as import("./approval-store.js").ApprovalRecord;
      },
      // Atomic guard found no pending row (already resolved / expired / unknown).
      async resolve() {
        return null;
      }
    };
    const auditEvents = {
      async create(input: unknown) {
        auditCalls.push(input);
      }
    };

    const wired = new ClaudeCodeRuntimeAdapter(
      testConfig,
      fakeDynamicConfig,
      fakeLog,
      makeTestManagedToolCatalog(),
      { approvals: richApprovals as never, auditEvents: auditEvents as never },
      undefined,
      testE2bOptions
    );
    await wired.createSession({ tenantId: "tenant-a", sessionId: "sess-dbl", userId: "user-1" });

    // Seed the pending entry so forwarding succeeds and we reach the DB guard;
    // resolve() returns null (row already settled) so no audit row is written.
    const approvalId = "already-settled";
    (wired as unknown as { e2bPendingApprovals: Map<string, string> }).e2bPendingApprovals.set(
      approvalId,
      "sess-dbl"
    );

    expect(
      await wired.resolveApproval({
        approvalId,
        tenantId: "tenant-a",
        userId: "user-1",
        decision: "approve"
      })
    ).toBe("resolved");
    expect(auditCalls).toHaveLength(0);
  });

  it("resolveApproval does NOT flip the DB row for an approval it doesn't own (so the owning adapter can)", async () => {
    // Regression guard for the multi-adapter route (Codex tried before Claude):
    // a non-owning adapter must not settle another provider's approval row.
    const resolveCalls: unknown[] = [];
    const richApprovals = {
      async create() {
        return {} as import("./approval-store.js").ApprovalRecord;
      },
      async resolve(...args: unknown[]) {
        resolveCalls.push(args);
        return null;
      }
    };
    const auditEvents = { async create() {} };

    const wired = new ClaudeCodeRuntimeAdapter(
      testConfig,
      fakeDynamicConfig,
      fakeLog,
      makeTestManagedToolCatalog(),
      { approvals: richApprovals as never, auditEvents: auditEvents as never },
      undefined,
      testE2bOptions
    );
    // A live session exists, but no pending approval with this id belongs to it
    // (e2bPendingApprovals has no entry), so forwardApprovalDecision returns
    // false and resolveApproval bails before touching the DB row.
    await wired.createSession({ tenantId: "tenant-a", sessionId: "sess-unowned", userId: "user-1" });

    const result = await wired.resolveApproval({
      approvalId: "owned-by-another-provider",
      tenantId: "tenant-a",
      userId: "user-1",
      decision: "approve"
    });

    expect(result).toBe("missing");
    // The DB row was never touched — the owning adapter, tried next, still sees
    // it as pending and can resolve it.
    expect(resolveCalls).toHaveLength(0);
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
