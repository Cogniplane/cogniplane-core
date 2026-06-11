import { describe, it, expect, vi, afterEach } from "vitest";

import { executeClaudeTurn, type ClaudeTurnContext } from "./claude-turn-executor.js";
import { phase4RuntimePolicy } from "../../test-helpers/phase4-runtime-policy.js";
import { ManagedToolCatalog } from "../managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../managed-tools/factory.js";
import { registerBuiltinManagedTools } from "../managed-tools/register-builtin-managed-tools.js";
import type { ClaudeSessionState } from "./claude-types.js";
import type { RuntimeConfigBundle } from "../admin-config-records.js";
import { SessionBusyError, type RuntimeEvent, type RuntimeSessionRef } from "../../runtime-contracts.js";
import type { SandboxApprovalRequestFrame } from "../runtime/sandbox-agent-protocol.js";
import type { E2bClaudeRuntimeProcess } from "../runtime/e2b-claude-runtime-process.js";
import type { FastifyBaseLogger } from "fastify";

// ── Shared test scaffolding ────────────────────────────────────────────────

function makeTestManagedToolCatalog(): ManagedToolCatalog {
  const catalog = new ManagedToolCatalog();
  registerBuiltinManagedTools(catalog, new ManagedToolFactoryRegistry());
  return catalog;
}

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
  level: "silent"
} as unknown as FastifyBaseLogger;

// The harness callbacks the executor wires into e2bProcess.runTurn. A test
// supplies a `drive` function that invokes whichever callbacks it wants with
// canned frames, simulating the in-sandbox harness.
type RunTurnListeners = Parameters<E2bClaudeRuntimeProcess["runTurn"]>[1];

/**
 * Minimal stand-in for the long-lived sandbox bridge. The executor only calls
 * `runTurn` (to start the turn) and `interruptCurrentTurn` (registered as the
 * Stop hook). `runTurn` here just hands the wired-up listeners to the test's
 * `drive` callback so the test controls exactly which frames arrive and in what
 * order, then resolves (or throws, for the failure-path cases).
 */
function makeFakeE2bProcess(
  drive: (listeners: RunTurnListeners) => void | Promise<void>
): E2bClaudeRuntimeProcess {
  return {
    interruptCurrentTurn: vi.fn(async () => true),
    sendApprovalResponse: vi.fn(async () => {}),
    runTurn: async (_frame: unknown, listeners: RunTurnListeners) => {
      await drive(listeners);
    }
  } as unknown as E2bClaudeRuntimeProcess;
}

function makeConfigBundle(): RuntimeConfigBundle {
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

function makeState(
  e2bProcess: E2bClaudeRuntimeProcess,
  overrides: Partial<ClaudeSessionState> = {}
): ClaudeSessionState {
  return {
    sessionId: "sess-1",
    tenantId: "tenant-1",
    userId: "user-1",
    runtimeId: "claude-runtime-1",
    workspacePath: "/home/user/workspace/sess-1",
    localStagingPath: "/tmp/staging",
    configBundle: makeConfigBundle(),
    abortController: new AbortController(),
    claudeSessionId: null,
    anthropicApiKey: "sk-ant-test",
    runtimeToken: "rt_test_token",
    proxyBaseUrl: "http://localhost:3001/llm/anthropic",
    mcpServerEntries: [],
    e2bProcess,
    activeTurnInterrupt: { current: null },
    activeTurnPush: { current: null },
    autoApprovedKindsForTurn: new Set(),
    ...overrides
  };
}

const session: RuntimeSessionRef = {
  sessionId: "sess-1",
  runtimeId: "claude-runtime-1",
  runtimePolicy: { ...phase4RuntimePolicy, runtimeProvider: "claude-code" as const }
};

function makeCtx(
  state: ClaudeSessionState,
  extras: Partial<ClaudeTurnContext> = {}
): ClaudeTurnContext {
  return {
    state,
    activeTurns: new Set<string>(),
    e2bPendingApprovals: new Map<string, { sessionId: string; kind: import("../../runtime-contracts.js").RuntimeApprovalKind }>(),
    stores: undefined,
    config: { CLAUDE_CODE_MODEL: "sonnet", APPROVAL_REQUEST_TTL_MS: 600_000 },
    log: silentLog,
    managedToolCatalog: makeTestManagedToolCatalog(),
    ...extras
  };
}

// A realistic SDK system/init frame. The executor logs tool-surface fields
// (payload.tools.length, payload.mcp_servers, …) for init messages, so the
// canned frame must carry them or the onSdkMessage handler throws before the
// mapper runs.
function initFrame(sessionId: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    tools: ["Bash", "Read"],
    mcp_servers: [{ name: "framework", status: "connected" }],
    cwd: "/home/user/workspace/sess-1",
    claude_code_version: "1.0.0"
  };
}

async function drain(iter: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const evt of iter) events.push(evt);
  return events;
}

const baseInput = {
  prompt: "hello",
  runtimePolicyId: "test",
  toolContextId: null
};

describe("executeClaudeTurn", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits non-terminal events before the deferred terminal completion event", async () => {
    // mapClaudeEvent(result/success) returns [output_item.done, response.completed].
    // The executor must push output_item.done immediately but hold response.completed
    // until onComplete fires — so a terminal success never races ahead of mid-turn
    // events. We drive an init (→ response.created) then a success result, then complete.
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      listeners.onSdkMessage(initFrame("claude-xyz"));
      listeners.onSdkMessage({ type: "result", subtype: "success" });
      listeners.onComplete("claude-xyz");
    });
    const state = makeState(e2bProcess);
    const events = await drain(executeClaudeTurn(session, baseInput, makeCtx(state)));

    const types = events.map((e) => e.type);
    // response.created and output_item.done are mid-turn; response.completed is terminal.
    expect(types).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed"
    ]);
    // The terminal event is strictly last — held until onComplete.
    expect(types.indexOf("response.completed")).toBe(types.length - 1);
    expect(types.indexOf("response.completed")).toBeGreaterThan(
      types.indexOf("response.output_item.done")
    );
  });

  it("falls back to a synthetic response.completed when no terminal SDK event was seen", async () => {
    // onComplete with no prior result message → executor emits its own completion.
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      listeners.onSdkMessage(initFrame("claude-only"));
      listeners.onComplete(null);
    });
    const events = await drain(executeClaudeTurn(session, baseInput, makeCtx(makeState(e2bProcess))));

    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toBeDefined();
    expect(events[events.length - 1].type).toBe("response.completed");
  });

  it("captures the claude session id from the first sdk message that carries one", async () => {
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      listeners.onSdkMessage(initFrame("claude-first"));
      // A later session_id must NOT overwrite the captured one.
      listeners.onSdkMessage({ type: "result", subtype: "success", session_id: "claude-second" });
      listeners.onComplete("claude-first");
    });
    const state = makeState(e2bProcess);
    await drain(executeClaudeTurn(session, baseInput, makeCtx(state)));
    expect(state.claudeSessionId).toBe("claude-first");
  });

  it("on runTurn throw with abort signal set, emits response.failed{message:'Session aborted'}", async () => {
    const state = makeState(
      makeFakeE2bProcess(() => {
        // Mark the turn as aborted, then throw — mirrors the Stop/abort path
        // where the bridge rejects after the controller fired.
        state.abortController.abort();
        throw new Error("sandbox stream closed");
      })
    );
    const events = await drain(executeClaudeTurn(session, baseInput, makeCtx(state)));

    const failed = events.find((e) => e.type === "response.failed");
    expect(failed).toBeDefined();
    // Aborted turns surface a sanitized message, never the raw bridge error.
    expect((failed as Extract<RuntimeEvent, { type: "response.failed" }>).message).toBe(
      "Session aborted"
    );
  });

  it("on runTurn throw without abort, emits response.failed with the raw error message", async () => {
    const state = makeState(
      makeFakeE2bProcess(() => {
        throw new Error("boom: harness exploded");
      })
    );
    const events = await drain(executeClaudeTurn(session, baseInput, makeCtx(state)));

    const failed = events.find((e) => e.type === "response.failed");
    expect(failed).toBeDefined();
    expect((failed as Extract<RuntimeEvent, { type: "response.failed" }>).message).toBe(
      "boom: harness exploded"
    );
  });

  it("forwards onFail frames as a response.failed event carrying the harness error", async () => {
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      listeners.onFail("model_overloaded");
    });
    const events = await drain(executeClaudeTurn(session, baseInput, makeCtx(makeState(e2bProcess))));

    const failed = events.find((e) => e.type === "response.failed");
    expect((failed as Extract<RuntimeEvent, { type: "response.failed" }>).message).toBe(
      "model_overloaded"
    );
  });

  it("finally block removes the session from activeTurns and clears activeTurnInterrupt", async () => {
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      listeners.onComplete(null);
    });
    const state = makeState(e2bProcess);
    const ctx = makeCtx(state);

    await drain(executeClaudeTurn(session, baseInput, ctx));

    // activeTurns is added at start; the finally block must remove it.
    expect(ctx.activeTurns.has(session.sessionId)).toBe(false);
    // The Stop hook is set during the turn and nulled afterwards so a late Stop
    // click can't reach into the next turn's iterator.
    expect(state.activeTurnInterrupt.current).toBeNull();
    // Same for the policy-approval push hook.
    expect(state.activeTurnPush.current).toBeNull();
  });

  it("cleans up activeTurns and the interrupt hook even when the turn fails", async () => {
    const state = makeState(
      makeFakeE2bProcess(() => {
        throw new Error("kaboom");
      })
    );
    const ctx = makeCtx(state);
    await drain(executeClaudeTurn(session, baseInput, ctx));

    expect(ctx.activeTurns.has(session.sessionId)).toBe(false);
    expect(state.activeTurnInterrupt.current).toBeNull();
  });

  it("reserves the activeTurns slot synchronously, before awaiting onBeforeTurn", async () => {
    const callOrder: string[] = [];
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      listeners.onComplete(null);
    });
    const state = makeState(e2bProcess);
    const ctx = makeCtx(state);
    const onBeforeTurn = vi.fn(async () => {
      // The slot must already be reserved here — otherwise a concurrent turn
      // could slip past the busy check during this (multi-second) await.
      callOrder.push(`before:active=${ctx.activeTurns.has(session.sessionId)}`);
    });

    await drain(executeClaudeTurn(session, { ...baseInput, onBeforeTurn }, ctx));

    expect(onBeforeTurn).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(["before:active=true"]);
    expect(ctx.activeTurns.has(session.sessionId)).toBe(false);
  });

  it("rejects a concurrent turn with SessionBusyError while the first is inside onBeforeTurn", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      listeners.onComplete(null);
    });
    const state = makeState(e2bProcess);
    const ctx = makeCtx(state);

    const first = drain(
      executeClaudeTurn(session, { ...baseInput, onBeforeTurn: () => gate }, ctx)
    );
    // Let the first turn enter onBeforeTurn (generator bodies start lazily).
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.activeTurns.has(session.sessionId)).toBe(true);

    // A second turn for the same session must lose immediately — without the
    // synchronous reservation it would pass the busy check, and its failure
    // path would clobber the first turn's activeTurns flag and hooks.
    await expect(drain(executeClaudeTurn(session, baseInput, ctx))).rejects.toThrow(
      SessionBusyError
    );

    // The loser must NOT have clobbered the first turn's reservation.
    expect(ctx.activeTurns.has(session.sessionId)).toBe(true);

    releaseFirst();
    await first;
    expect(ctx.activeTurns.has(session.sessionId)).toBe(false);
  });

  it("fires onTurnStart at reservation and onTurnEnd when the turn settles (idle-timer hooks)", async () => {
    const order: string[] = [];
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      order.push("turn-running");
      listeners.onComplete(null);
    });
    const ctx = makeCtx(makeState(e2bProcess), {
      onTurnStart: () => order.push("start"),
      onTurnEnd: () => order.push("end")
    });

    await drain(executeClaudeTurn(session, baseInput, ctx));
    expect(order).toEqual(["start", "turn-running", "end"]);

    // onBeforeTurn failure must still re-arm via onTurnEnd.
    order.length = 0;
    await expect(
      drain(
        executeClaudeTurn(
          session,
          {
            ...baseInput,
            onBeforeTurn: async () => {
              throw new Error("sync failed");
            }
          },
          ctx
        )
      )
    ).rejects.toThrow("sync failed");
    expect(order).toEqual(["start", "end"]);
  });

  it("releases the reservation when onBeforeTurn throws", async () => {
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      listeners.onComplete(null);
    });
    const state = makeState(e2bProcess);
    const ctx = makeCtx(state);

    await expect(
      drain(
        executeClaudeTurn(
          session,
          {
            ...baseInput,
            onBeforeTurn: async () => {
              throw new Error("artifact sync failed");
            }
          },
          ctx
        )
      )
    ).rejects.toThrow("artifact sync failed");

    // The slot is free again — a follow-up turn runs normally.
    expect(ctx.activeTurns.has(session.sessionId)).toBe(false);
    const events = await drain(executeClaudeTurn(session, baseInput, ctx));
    expect(events.some((e) => e.type === "response.completed")).toBe(true);
  });

  describe("onApprovalRequest", () => {
    const approvalFrame: SandboxApprovalRequestFrame = {
      type: "approval_request",
      approvalId: "appr-1",
      toolName: "Bash",
      toolInput: { command: "ls -la" },
      kind: "command_execution"
    };

    it("registers the approval, persists it with a TTL deadline, and emits framework:approval_required", async () => {
      // Freeze the clock so the persisted expiresAt is deterministic relative to TTL.
      vi.useFakeTimers();
      const now = new Date("2026-05-30T12:00:00.000Z");
      vi.setSystemTime(now);

      const createCalls: Array<Record<string, unknown>> = [];
      const approvals = {
        async create(input: Record<string, unknown>) {
          createCalls.push(input);
          return {} as never;
        }
      };

      const e2bProcess = makeFakeE2bProcess(async (listeners) => {
        listeners.onApprovalRequest(approvalFrame);
        // Let the deferred dispatch (void Promise) settle before the turn ends.
        await Promise.resolve();
        await Promise.resolve();
        listeners.onComplete(null);
      });
      const state = makeState(e2bProcess);
      const ctx = makeCtx(state, { stores: { approvals: approvals as never } });

      const events = await drain(executeClaudeTurn(session, baseInput, ctx));

      // The approvalId → sessionId mapping is registered so resolveApproval can
      // forward the decision to the right sandbox.
      expect(ctx.e2bPendingApprovals.get("appr-1")).toEqual({ sessionId: state.sessionId, kind: "command_execution", autoApprovedKinds: expect.any(Set) });

      // Persisted exactly once, with the TTL deadline = now + APPROVAL_REQUEST_TTL_MS.
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toMatchObject({
        tenantId: state.tenantId,
        approvalId: "appr-1",
        sessionId: state.sessionId,
        userId: state.userId,
        runtimeId: state.runtimeId,
        kind: "command_execution",
        requestMethod: "claude/Bash",
        status: "pending"
      });
      expect(createCalls[0].expiresAt).toBe(
        new Date(now.getTime() + ctx.config.APPROVAL_REQUEST_TTL_MS).toISOString()
      );

      // The SSE event the frontend consumes to render the approval prompt.
      const approvalEvent = events.find((e) => e.type === "framework:approval_required");
      expect(approvalEvent).toBeDefined();
      const ev = approvalEvent as Extract<RuntimeEvent, { type: "framework:approval_required" }>;
      expect(ev.approvalId).toBe("appr-1");
      expect(ev.availableDecisions).toEqual(["approve", "reject"]);
      expect(ev.kind).toBe("command_execution");
      expect(ev.command).toBe("Bash");
      expect(ev.cwd).toBe(state.workspacePath);
    });

    it("still emits framework:approval_required even when approvals.create rejects", async () => {
      // A persistence failure must not swallow the in-flight approval prompt —
      // the user can still approve/reject; the DB row just won't survive a crash.
      const approvals = {
        async create() {
          throw new Error("db down");
        }
      };

      const e2bProcess = makeFakeE2bProcess(async (listeners) => {
        listeners.onApprovalRequest(approvalFrame);
        await Promise.resolve();
        await Promise.resolve();
        listeners.onComplete(null);
      });
      const state = makeState(e2bProcess);
      const ctx = makeCtx(state, { stores: { approvals: approvals as never } });

      const events = await drain(executeClaudeTurn(session, baseInput, ctx));

      // Mapping registered regardless of the store outcome.
      expect(ctx.e2bPendingApprovals.get("appr-1")).toEqual({ sessionId: state.sessionId, kind: "command_execution", autoApprovedKinds: expect.any(Set) });
      const approvalEvent = events.find((e) => e.type === "framework:approval_required");
      expect(approvalEvent).toBeDefined();
      expect(
        (approvalEvent as Extract<RuntimeEvent, { type: "framework:approval_required" }>)
          .availableDecisions
      ).toEqual(["approve", "reject"]);
    });

    it("emits framework:approval_required even with no approval store wired", async () => {
      // stores undefined → no persistence path, but the prompt must still fire.
      const e2bProcess = makeFakeE2bProcess(async (listeners) => {
        listeners.onApprovalRequest(approvalFrame);
        await Promise.resolve();
        await Promise.resolve();
        listeners.onComplete(null);
      });
      const state = makeState(e2bProcess);
      const ctx = makeCtx(state, { stores: undefined });

      const events = await drain(executeClaudeTurn(session, baseInput, ctx));

      expect(ctx.e2bPendingApprovals.get("appr-1")).toEqual({ sessionId: state.sessionId, kind: "command_execution", autoApprovedKinds: expect.any(Set) });
      expect(events.some((e) => e.type === "framework:approval_required")).toBe(true);
    });

    it("auto-approves a remembered kind without a DB row or prompt (rememberForTurn)", async () => {
      const createCalls: unknown[] = [];
      const approvals = {
        async create(input: unknown) {
          createCalls.push(input);
          return {} as never;
        }
      };

      const e2bProcess = makeFakeE2bProcess(async (listeners) => {
        // Simulates a prior approve-with-remember earlier in this same turn
        // (forwardApprovalDecision records the kind mid-turn, after the
        // executor's turn-start clear).
        state.autoApprovedKindsForTurn.add("command_execution");
        listeners.onApprovalRequest(approvalFrame);
        await Promise.resolve();
        await Promise.resolve();
        listeners.onComplete(null);
      });
      const state = makeState(e2bProcess);
      const ctx = makeCtx(state, { stores: { approvals: approvals as never } });

      const events = await drain(executeClaudeTurn(session, baseInput, ctx));

      // Answered straight back to the harness: no pending entry, no DB row,
      // no user prompt.
      expect(e2bProcess.sendApprovalResponse).toHaveBeenCalledWith("appr-1", "approve");
      expect(ctx.e2bPendingApprovals.has("appr-1")).toBe(false);
      expect(createCalls).toHaveLength(0);
      expect(events.some((e) => e.type === "framework:approval_required")).toBe(false);
    });

    it("clears remembered kinds at turn start", async () => {
      const e2bProcess = makeFakeE2bProcess(async (listeners) => {
        listeners.onApprovalRequest(approvalFrame);
        await Promise.resolve();
        await Promise.resolve();
        listeners.onComplete(null);
      });
      const state = makeState(e2bProcess);
      // Left over from a previous turn — must not leak into this one.
      state.autoApprovedKindsForTurn.add("command_execution");
      const ctx = makeCtx(state);

      const events = await drain(executeClaudeTurn(session, baseInput, ctx));

      // The stale remembered kind was cleared, so the request prompts normally.
      expect(e2bProcess.sendApprovalResponse).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === "framework:approval_required")).toBe(true);
      expect(ctx.e2bPendingApprovals.has("appr-1")).toBe(true);
    });
  });

  it("registers a Stop hook that delegates to e2bProcess.interruptCurrentTurn", async () => {
    let capturedInterrupt: (() => Promise<void>) | null = null;
    const e2bProcess = makeFakeE2bProcess(async (listeners) => {
      // Capture the live hook mid-turn (it is cleared in the finally block).
      capturedInterrupt = state.activeTurnInterrupt.current;
      listeners.onComplete(null);
    });
    const state = makeState(e2bProcess);
    await drain(executeClaudeTurn(session, baseInput, makeCtx(state)));

    expect(capturedInterrupt).toBeTypeOf("function");
    // Invoking the captured hook routes the Stop to the in-sandbox harness.
    await capturedInterrupt!();
    expect(e2bProcess.interruptCurrentTurn).toHaveBeenCalledWith(expect.any(String));
  });
});
