import { test, expect } from "vitest";

import { AsyncQueue } from "../../lib/async-queue.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { JsonRpcRequest } from "./codex-jsonrpc.js";
import type { ActiveTurnState, RuntimeProcessHandle, RuntimeState } from "./runtime-types.js";

import {
  clearAllApprovalExpiries,
  clearApprovalExpiry,
  handleRuntimeRequest
} from "./runtime-request-handler.js";

type ResponseRecord = {
  kind: "response";
  id: string | number;
  result: Record<string, unknown>;
};

type ErrorRecord = {
  kind: "error";
  id: string | number;
  code: number;
  message: string;
};

function makeProcess(): {
  process: Pick<RuntimeProcessHandle, "sendResponse" | "sendError">;
  events: Array<ResponseRecord | ErrorRecord>;
} {
  const events: Array<ResponseRecord | ErrorRecord> = [];
  return {
    events,
    process: {
      sendResponse: (id, result) => events.push({ kind: "response", id, result }),
      sendError: (id, code, message) => events.push({ kind: "error", id, code, message })
    }
  };
}

function makeActiveTurn(overrides: Partial<ActiveTurnState> = {}): ActiveTurnState {
  return {
    queue: new AsyncQueue(),
    responseId: "resp-1",
    outputItemDone: false,
    runtimePolicyId: "default",
    toolContextId: null,
    assistantMessageId: null,
    tokenUsage: null,
    model: null,
    effort: null,
    autoApprovedKinds: new Set(),
    ...overrides
  };
}

function makeRuntime(opts: {
  proc: Pick<RuntimeProcessHandle, "sendResponse" | "sendError">;
  activeTurn?: ActiveTurnState | null;
  pendingApprovals?: number;
}): RuntimeState {
  const pendingApprovals = new Map();
  for (let i = 0; i < (opts.pendingApprovals ?? 0); i++) {
    pendingApprovals.set(`prev-${i}`, {
      approvalId: `prev-${i}`,
      requestId: `r-${i}`,
      method: "item/permissions/requestApproval",
      itemId: `it-${i}`,
      kind: "permissions"
    });
  }

  return {
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    runtimeId: "rt",
    provider: "codex",
    workspacePath: "/tmp/ws",
    manifestPath: "/tmp/manifest.json",
    manifest: {} as RuntimeState["manifest"],
    runtimePolicy: {} as RuntimeState["runtimePolicy"],
    process: opts.proc as unknown as RuntimeProcessHandle,
    threadId: "thread",
    claudeSessionId: null,
    claudeResumeAt: null,
    activeTurn: opts.activeTurn === undefined ? makeActiveTurn() : opts.activeTurn,
    pendingApprovals,
    pendingApprovalTimers: new Map(),
    idleTimer: null,
    healthStatus: "healthy",
    startedAt: "now",
    lastActiveAt: "now",
    terminatedAt: null,
    lifecycleMetadata: {},
    shutdownReason: null,
    finalized: false,
    closed: false
  };
}

function makeStores() {
  const approvalCalls: unknown[] = [];
  const auditCalls: unknown[] = [];
  const approvals: Pick<ApprovalStore, "create" | "expire"> = {
    async create(input) {
      approvalCalls.push(input);
      return {
        ...input,
        tenantId: "t",
        decision: null,
        createdAt: "now",
        updatedAt: "now",
        resolvedAt: null
      } as unknown as Awaited<ReturnType<ApprovalStore["create"]>>;
    },
    async expire() {
      return null;
    }
  };
  const auditEvents: Pick<AuditEventStore, "create"> = {
    async create(input) {
      auditCalls.push(input);
      return {} as unknown as Awaited<ReturnType<AuditEventStore["create"]>>;
    }
  };
  return { approvals, auditEvents, approvalCalls, auditCalls };
}

const baseRequest = (overrides: Partial<JsonRpcRequest> = {}): JsonRpcRequest => ({
  id: 1,
  method: "item/commandExecution/requestApproval",
  params: { command: "ls", cwd: "/tmp", approvalId: "ap-1", itemId: "it-1", turnId: "t-1" },
  ...overrides
});

test("auto-approves mcpServer/elicitation/request without touching stores", async () => {
  const { process: proc, events } = makeProcess();
  const runtime = makeRuntime({ proc });
  const stores = makeStores();

  await handleRuntimeRequest({
    tenantId: "t",
    runtime,
    request: { id: 99, method: "mcpServer/elicitation/request" },
    approvals: stores.approvals,
    auditEvents: stores.auditEvents,
    approvalTtlMs: 1_000,
    logger: createSilentLogger()
  });

  expect(events).toEqual([{ kind: "response", id: 99, result: { action: "accept" } }]);
  expect(stores.approvalCalls.length).toBe(0);
  expect(stores.auditCalls.length).toBe(0);
});

test("rejects with -32000 if there is no active turn", async () => {
  const { process: proc, events } = makeProcess();
  const runtime = makeRuntime({ proc, activeTurn: null });
  const stores = makeStores();

  await handleRuntimeRequest({
    tenantId: "t",
    runtime,
    request: baseRequest(),
    approvals: stores.approvals,
    auditEvents: stores.auditEvents,
    approvalTtlMs: 1_000,
    logger: createSilentLogger()
  });

  expect(events.length).toBe(1);
  expect(events[0].kind).toBe("error");
  expect((events[0] as ErrorRecord).code).toBe(-32000);
  expect((events[0] as ErrorRecord).message).toMatch(/no active turn/i);
});

test("rejects with -32000 when MAX_PENDING_APPROVALS is hit", async () => {
  const { process: proc, events } = makeProcess();
  const runtime = makeRuntime({ proc, pendingApprovals: 5 });
  const stores = makeStores();

  await handleRuntimeRequest({
    tenantId: "t",
    runtime,
    request: baseRequest(),
    approvals: stores.approvals,
    auditEvents: stores.auditEvents,
    approvalTtlMs: 1_000,
    logger: createSilentLogger()
  });

  expect(events.length).toBe(1);
  expect((events[0] as ErrorRecord).code).toBe(-32000);
  expect((events[0] as ErrorRecord).message).toMatch(/rate limit/i);
  expect(stores.approvalCalls.length).toBe(0);
});

test("rejects with -32601 for an unknown method", async () => {
  const { process: proc, events } = makeProcess();
  const runtime = makeRuntime({ proc });
  const stores = makeStores();

  await handleRuntimeRequest({
    tenantId: "t",
    runtime,
    request: { id: 7, method: "totally/unknown" },
    approvals: stores.approvals,
    auditEvents: stores.auditEvents,
    approvalTtlMs: 1_000,
    logger: createSilentLogger()
  });

  expect(events.length).toBe(1);
  expect((events[0] as ErrorRecord).code).toBe(-32601);
  expect((events[0] as ErrorRecord).message).toMatch(/Unsupported request method totally\/unknown/);
});

test("auto-approves when turn already approved this kind without writing rows", async () => {
  const { process: proc, events } = makeProcess();
  const turn = makeActiveTurn({
    autoApprovedKinds: new Set(["command_execution"])
  });
  const runtime = makeRuntime({ proc, activeTurn: turn });
  const stores = makeStores();

  await handleRuntimeRequest({
    tenantId: "t",
    runtime,
    request: baseRequest(),
    approvals: stores.approvals,
    auditEvents: stores.auditEvents,
    approvalTtlMs: 1_000,
    logger: createSilentLogger()
  });

  // Auto-approval sends an item-protocol "accept"
  expect(events.length).toBe(1);
  expect(events[0]).toEqual({
        kind: "response",
        id: 1,
        result: { decision: "accept" }
      });
  // No DB writes
  expect(stores.approvalCalls.length).toBe(0);
  expect(stores.auditCalls.length).toBe(0);
  // No queued approval prompt for the user
  expect(runtime.activeTurn!.queue["values"]?.length ?? 0).toBe(0);
});

test("happy path: persists approval row, writes audit event, queues prompt event", async () => {
  const { process: proc, events } = makeProcess();
  const runtime = makeRuntime({ proc });
  const stores = makeStores();

  await handleRuntimeRequest({
    tenantId: "t",
    runtime,
    request: baseRequest(),
    approvals: stores.approvals,
    auditEvents: stores.auditEvents,
    approvalTtlMs: 60_000,
    logger: createSilentLogger()
  });

  // No immediate response — the runtime is paused waiting for the user.
  expect(events.length).toBe(0);

  // Pending approval recorded in memory
  expect(runtime.pendingApprovals.size).toBe(1);
  expect(runtime.pendingApprovals.has("ap-1")).toBeTruthy();

  // DB row created
  expect(stores.approvalCalls.length).toBe(1);
  const created = stores.approvalCalls[0] as Record<string, unknown>;
  expect(created.kind).toBe("command_execution");
  expect(created.requestMethod).toBe("item/commandExecution/requestApproval");
  expect(created.status).toBe("pending");

  // Audit event written
  expect(stores.auditCalls.length).toBe(1);
  const audit = stores.auditCalls[0] as Record<string, unknown>;
  expect(audit.type).toBe("approval.requested");

  // Expiry timer registered
  expect(runtime.pendingApprovalTimers.size).toBe(1);

  // Active turn received a framework:approval_required event
  const turnQueue = runtime.activeTurn!.queue;
  // Drain the queue end-of-stream so the iterator can complete
  turnQueue.end();
  const queued: unknown[] = [];
  for await (const v of turnQueue) queued.push(v);
  expect(queued.length).toBe(1);
  expect((queued[0] as Record<string, unknown>).type).toBe("framework:approval_required");

  // Cleanup: prevent leaked timer
  clearAllApprovalExpiries(runtime);
});

test("expiry timer fires: synthesizes reject and writes approval.expired audit", async () => {
  const { process: proc, events } = makeProcess();
  const runtime = makeRuntime({ proc });

  // Track expire() calls on the approval store and have them succeed.
  const expireArgs: Array<[string, string]> = [];
  const approvals: Pick<ApprovalStore, "create" | "expire"> = {
    async create(input) {
      return { ...input, decision: null, createdAt: "n", updatedAt: "n", resolvedAt: null } as unknown as Awaited<ReturnType<ApprovalStore["create"]>>;
    },
    async expire(tenantId, approvalId) {
      expireArgs.push([tenantId, approvalId]);
      return { approvalId, status: "expired" } as unknown as Awaited<ReturnType<ApprovalStore["expire"]>>;
    }
  };
  const auditCalls: unknown[] = [];
  const auditEvents: Pick<AuditEventStore, "create"> = {
    async create(input) {
      auditCalls.push(input);
      return {} as unknown as Awaited<ReturnType<AuditEventStore["create"]>>;
    }
  };

  await handleRuntimeRequest({
    tenantId: "t",
    runtime,
    request: baseRequest(),
    approvals,
    auditEvents,
    approvalTtlMs: 5,
    logger: createSilentLogger()
  });

  expect(runtime.pendingApprovalTimers.size).toBe(1);

  // Wait for the timer to fire and its async expireApproval to settle.
  await new Promise((r) => setTimeout(r, 30));

  // Approval was expired in the DB
  expect(expireArgs).toEqual([["t", "ap-1"]]);
  // Pending state cleared
  expect(runtime.pendingApprovals.size).toBe(0);
  expect(runtime.pendingApprovalTimers.size).toBe(0);

  // A "reject"-style response was sent to the runtime process
  const responses = events.filter((e): e is ResponseRecord => e.kind === "response");
  expect(responses.length).toBe(1);
  // item/commandExecution/requestApproval rejection => decision: "decline"
  expect(responses[0].result).toEqual({ decision: "decline" });

  // Two audit events: the original approval.requested and the approval.expired.
  expect(auditCalls.length).toBe(2);
  expect((auditCalls[0] as Record<string, unknown>).type).toBe("approval.requested");
  expect((auditCalls[1] as Record<string, unknown>).type).toBe("approval.expired");

  // A runtime_notice event was queued for the active turn
  runtime.activeTurn!.queue.end();
  const queued: unknown[] = [];
  for await (const v of runtime.activeTurn!.queue) queued.push(v);
  // First was the original framework:approval_required, second is the runtime_notice
  expect(queued.length).toBe(2);
  expect((queued[1] as Record<string, unknown>).type).toBe("framework:runtime_notice");
});

test("expiry no-ops when the DB row was already resolved (race)", async () => {
  const { process: proc, events } = makeProcess();
  const runtime = makeRuntime({ proc });

  const approvals: Pick<ApprovalStore, "create" | "expire"> = {
    async create(input) {
      return { ...input, decision: null, createdAt: "n", updatedAt: "n", resolvedAt: null } as unknown as Awaited<ReturnType<ApprovalStore["create"]>>;
    },
    // DB returns null => already approved/rejected by the user concurrently.
    async expire() {
      return null;
    }
  };
  const auditCalls: unknown[] = [];
  const auditEvents: Pick<AuditEventStore, "create"> = {
    async create(input) {
      auditCalls.push(input);
      return {} as unknown as Awaited<ReturnType<AuditEventStore["create"]>>;
    }
  };

  await handleRuntimeRequest({
    tenantId: "t",
    runtime,
    request: baseRequest(),
    approvals,
    auditEvents,
    approvalTtlMs: 5,
    logger: createSilentLogger()
  });

  await new Promise((r) => setTimeout(r, 30));

  // Pending approval is preserved (the user's decision will resolve it)
  expect(runtime.pendingApprovals.size).toBe(1);
  // No reject was sent to the process — only the original (none)
  expect(events.filter((e) => e.kind === "response").length).toBe(0);
  // Only the original approval.requested audit event is present
  expect(auditCalls.length).toBe(1);

  // Cleanup
  clearAllApprovalExpiries(runtime);
});

test("clearApprovalExpiry removes only the matching timer", () => {
  const { process: proc } = makeProcess();
  const runtime = makeRuntime({ proc });
  const t1 = setTimeout(() => {}, 10_000);
  const t2 = setTimeout(() => {}, 10_000);
  runtime.pendingApprovalTimers.set("a", t1);
  runtime.pendingApprovalTimers.set("b", t2);

  clearApprovalExpiry(runtime, "a");
  expect(runtime.pendingApprovalTimers.has("a")).toBe(false);
  expect(runtime.pendingApprovalTimers.has("b")).toBe(true);

  // A no-op for unknown ids — no throw.
  clearApprovalExpiry(runtime, "missing");
  expect(runtime.pendingApprovalTimers.size).toBe(1);

  clearAllApprovalExpiries(runtime);
  expect(runtime.pendingApprovalTimers.size).toBe(0);
});
