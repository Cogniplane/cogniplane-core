import { describe, expect, test } from "vitest";

import { FakePool } from "../../test-helpers/fake-pool.js";
import { SessionExecutionError } from "../session-execution-store.js";
import { ApprovalStore, type ApprovalRecord } from "./approval-store.js";

// Unit tests for the store's own decisions. The SQL predicates and RLS are
// proven against Postgres in src/integration/approval-*.integration.test.ts
// and rls-write-paths.integration.test.ts; this fake only answers by the
// values each statement binds.

const T0 = "2026-10-01T12:00:00.000Z";

type CreateInput = Parameters<ApprovalStore["create"]>[0];

function createInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    tenantId: "tenant-a",
    approvalId: "approval-1",
    sessionId: "session-1",
    userId: "user-1",
    runtimeId: "runtime-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestMethod: "tools/call",
    requestId: "request-1",
    kind: "mcp_tool",
    title: "Send email",
    summary: "Send one email",
    status: "pending",
    decision: null,
    requestPayload: { tool: "send_email" },
    expiresAt: "2026-10-01T12:05:00.000Z",
    ...overrides
  };
}

function approvalRow(values: unknown[]): Record<string, unknown> {
  const [tenantId, approvalId, sessionId, userId, runtimeId, turnId, itemId, requestMethod, requestId,
    kind, title, summary, status, decision, payload, expiresAt, toolCallId] = values;
  return {
    tenant_id: tenantId, approval_id: approvalId, session_id: sessionId, user_id: userId,
    runtime_id: runtimeId, turn_id: turnId, item_id: itemId, request_method: requestMethod,
    request_id: requestId, kind, title, summary, status, decision,
    request_payload: JSON.parse(String(payload)), remember_for_turn: false,
    created_at: T0, updated_at: T0, resolved_at: null, expires_at: expiresAt, tool_call_id: toolCallId
  };
}

type Session = { tenantId: string; sessionId: string; projectId: string | null; hasExecution: boolean };
type Execution = { tenantId: string; sessionId: string; userId: string; runtimeId: string };

// A pool that knows one session and, optionally, one active execution.
function creationPool(session: Session | null, execution: Execution | null = null) {
  return new FakePool()
    .onQuery("AS has_execution FROM sessions", (_sql, [tenantId, sessionId]) => {
      const match = session && session.tenantId === tenantId && session.sessionId === sessionId;
      return match
        ? { rows: [{ project_id: session.projectId, has_execution: session.hasExecution }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    })
    .onQuery("FOR SHARE OF e", (_sql, [tenantId, sessionId, userId, runtimeId]) => {
      const match = execution && execution.tenantId === tenantId && execution.sessionId === sessionId &&
        execution.userId === userId && execution.runtimeId === runtimeId;
      return match ? { rows: [{ execution_id: "execution-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    })
    .onQuery("INSERT INTO approvals", (_sql, values) => ({ rows: [approvalRow(values)], rowCount: 1 }));
}

function statements(pool: FakePool): string[] {
  return pool.queries.map(query => query.text.trim());
}

function tenantScopes(pool: FakePool): unknown[] {
  return pool.queries.filter(query => query.text.includes("set_config")).map(query => query.values[0]);
}

/** The audit rows that the store inserted: [tenant, session, user, approval, type, payload]. */
function auditInserts(pool: FakePool): unknown[][] {
  return pool.queries.filter(query => query.text.includes("INSERT INTO audit_events"))
    .map(query => [...query.values.slice(0, 5), JSON.parse(String(query.values[5]))]);
}

function acceptAudits(pool: FakePool, fail = false): FakePool {
  return pool.onQuery("INSERT INTO audit_events", () => {
    if (fail) throw new Error("audit insert failed");
    return { rows: [], rowCount: 1 };
  });
}

function insertCount(pool: FakePool): number {
  return pool.queries.filter(query => query.text.includes("INSERT INTO approvals")).length;
}

describe("ApprovalStore.create", () => {
  test("stores a standalone approval under the caller's tenant without an execution check", async () => {
    const pool = creationPool({ tenantId: "tenant-a", sessionId: "session-1", projectId: null, hasExecution: false });

    const record = await new ApprovalStore(pool.asPool()).create(createInput());

    expect(record).toMatchObject({
      approvalId: "approval-1",
      tenantId: "tenant-a",
      sessionId: "session-1",
      userId: "user-1",
      runtimeId: "runtime-1",
      kind: "mcp_tool",
      status: "pending",
      decision: null,
      requestPayload: { tool: "send_email" },
      expiresAt: "2026-10-01T12:05:00.000Z"
    });
    expect(tenantScopes(pool)).toEqual(["tenant-a"]);
    expect(pool.queries.some(query => query.text.includes("FOR SHARE OF e"))).toBe(false);
    expect(statements(pool).at(-1)).toBe("COMMIT");
  });

  test("stores the server ID of the proposed call, and reads a row without one as unlinked", async () => {
    const session = { tenantId: "tenant-a", sessionId: "session-1", projectId: null, hasExecution: false };
    const linkedPool = creationPool(session);
    const linked = await new ApprovalStore(linkedPool.asPool()).create(createInput({ toolCallId: "card-1" }));
    expect(linked.toolCallId).toBe("card-1");
    expect(linkedPool.queries.find((query) => query.text.includes("INSERT INTO approvals"))!.values.at(-1)).toBe("card-1");

    const unlinkedPool = creationPool(session);
    const unlinked = await new ApprovalStore(unlinkedPool.asPool()).create(createInput());
    expect(unlinkedPool.queries.find((query) => query.text.includes("INSERT INTO approvals"))!.values.at(-1)).toBeNull();
    expect(unlinked).not.toHaveProperty("toolCallId");
  });

  test.each([
    ["a project session", { projectId: "project-1", hasExecution: false }],
    ["a standalone session that has run an admitted turn", { projectId: null, hasExecution: true }]
  ])("refuses %s without an active execution for the same user and runtime", async (_label, shape) => {
    const pool = creationPool(
      { tenantId: "tenant-a", sessionId: "session-1", ...shape },
      { tenantId: "tenant-a", sessionId: "session-1", userId: "user-2", runtimeId: "runtime-1" }
    );

    const error = await new ApprovalStore(pool.asPool()).create(createInput()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionExecutionError);
    expect(error).toMatchObject({ code: "execution_stopped", statusCode: 403 });
    expect(insertCount(pool)).toBe(0);
    expect(statements(pool)).toContain("ROLLBACK");
    expect(statements(pool)).not.toContain("COMMIT");
  });

  test("stores a project approval when the requesting user and runtime own the active execution", async () => {
    const pool = creationPool(
      { tenantId: "tenant-a", sessionId: "session-1", projectId: "project-1", hasExecution: true },
      { tenantId: "tenant-a", sessionId: "session-1", userId: "user-1", runtimeId: "runtime-1" }
    );

    const record = await new ApprovalStore(pool.asPool()).create(createInput());

    expect(record.approvalId).toBe("approval-1");
    expect(insertCount(pool)).toBe(1);
    expect(statements(pool).at(-1)).toBe("COMMIT");
  });

  test("refuses a project approval whose active execution uses another runtime", async () => {
    const pool = creationPool(
      { tenantId: "tenant-a", sessionId: "session-1", projectId: "project-1", hasExecution: true },
      { tenantId: "tenant-a", sessionId: "session-1", userId: "user-1", runtimeId: "runtime-old" }
    );

    await expect(new ApprovalStore(pool.asPool()).create(createInput())).rejects.toMatchObject({ code: "execution_stopped" });
    expect(insertCount(pool)).toBe(0);
  });
});

describe("ApprovalStore decisions", () => {
  // The WHERE predicates run against Postgres in approval-resolve and
  // approval-consume.
  function decisionPool(failAudit = false) {
    return acceptAudits(new FakePool(), failAudit)
      .onQuery("SET status = $4", (_sql, [, , , status, decision, remember]) => ({
        rows: [{
          ...approvalRow(["tenant-a", "approval-1", "session-1", "user-1", "runtime-1", "turn-1", "item-1",
            "tools/call", "request-1", "mcp_tool", "Send email", "Send one email", status, null, "{}", T0]),
          decision, remember_for_turn: remember, resolved_at: T0
        }],
        rowCount: 1
      }))
      .onQuery("SET consumed_at", (_sql, [, approvalId]) => ({ rows: [{ approval_id: approvalId }], rowCount: 1 }));
  }

  test("remembers a decision for the turn only when it approves", async () => {
    const approvePool = decisionPool();
    const approved = await new ApprovalStore(approvePool.asPool()).resolve("tenant-a", "approval-1", "user-1", "approve", true);
    expect(approved).toMatchObject({ status: "approved", decision: "approve", rememberForTurn: true });

    const rejectPool = decisionPool();
    const rejected = await new ApprovalStore(rejectPool.asPool()).resolve("tenant-a", "approval-1", "user-1", "reject", true);
    expect(rejected).toMatchObject({ status: "rejected", decision: "reject", rememberForTurn: false });
    expect(tenantScopes(rejectPool)).toEqual(["tenant-a"]);
  });

  test("writes the decision's audit event in the decision's transaction", async () => {
    const pool = decisionPool();
    await new ApprovalStore(pool.asPool()).resolve("tenant-a", "approval-1", "user-1", "reject");
    expect(auditInserts(pool)).toEqual([
      ["tenant-a", "session-1", "user-1", "approval-1", "approval.rejected", { itemId: "item-1", kind: "mcp_tool" }]
    ]);
    const texts = pool.queries.map(({ text }) => text.trim().split(/\s+/).slice(0, 2).join(" "));
    expect(texts.indexOf("INSERT INTO")).toBeLessThan(texts.indexOf("COMMIT"));
  });

  test("rolls the decision back when its audit event cannot be written", async () => {
    const pool = decisionPool(true);
    await expect(new ApprovalStore(pool.asPool()).resolve("tenant-a", "approval-1", "user-1", "approve"))
      .rejects.toThrow("audit insert failed");
    expect(pool.queries.map(({ text }) => text.trim())).toContain("ROLLBACK");
    expect(pool.queries.map(({ text }) => text.trim())).not.toContain("COMMIT");
  });

  test("binds the tenant, approval and user in that order for resolve and consume", async () => {
    const pool = decisionPool();
    const store = new ApprovalStore(pool.asPool());

    await store.resolve("tenant-a", "approval-1", "user-1", "approve", true);
    await expect(store.consume("tenant-a", "approval-1", "user-1")).resolves.toBe(true);
    expect(pool.queries.filter(({ text }) => text.includes("UPDATE approvals")).map(({ values }) => values)).toEqual([
      ["tenant-a", "approval-1", "user-1", "approved", "approve", true],
      ["tenant-a", "approval-1", "user-1"]
    ]);
  });

  test("reads an approval only for its own user and maps unknown values to safe defaults", async () => {
    const pool = new FakePool().onQuery("FROM approvals", (_sql, [tenantId, approvalId, userId]) =>
      tenantId === "tenant-a" && approvalId === "approval-1" && userId === "user-1"
        ? {
          rows: [{
            ...approvalRow(["tenant-a", "approval-1", "session-1", "user-1", "runtime-1", "turn-1", "item-1",
              "tools/call", "request-1", "shell", "Run", "Run one command", "granted", "maybe", "{}", T0]),
            request_payload: "not-an-object",
            remember_for_turn: "true"
          }],
          rowCount: 1
        }
        : { rows: [], rowCount: 0 });
    const store = new ApprovalStore(pool.asPool());

    expect(await store.get("tenant-a", "approval-1", "user-2")).toBeNull();
    const record = await store.get("tenant-a", "approval-1", "user-1");
    expect(record).toMatchObject<Partial<ApprovalRecord>>({
      kind: "command_execution",
      status: "pending",
      decision: null,
      rememberForTurn: false,
      requestPayload: {}
    });
  });

  test("lists and expires pending approvals inside the caller's tenant scope", async () => {
    const pool = acceptAudits(new FakePool())
      .onQuery(/status = 'pending'\s+ORDER BY/, (_sql, values) => ({
        rows: [approvalRow([values[0], "approval-1", values[1], values[2], "runtime-1", "turn-1", "item-1",
          "tools/call", "request-1", "file_change", "Edit", "Edit a file", "pending", null, "{}", T0])],
        rowCount: 1
      }))
      .onQuery("SET status = 'expired'", (_sql, [tenantId, approvalId]) => ({
        rows: [approvalRow([tenantId, approvalId, "session-1", "user-1", "runtime-1", "turn-1", "item-1",
          "tools/call", "request-1", "permissions", "Grant", "Grant access", "expired", null, "{}", T0])],
        rowCount: 1
      }));
    const store = new ApprovalStore(pool.asPool());

    const listed = await store.listPending("tenant-a", "session-1", "user-1");
    const expired = await store.expire("tenant-b", "approval-9", "turn_interrupted");

    expect(listed.map(record => [record.tenantId, record.sessionId, record.userId, record.kind]))
      .toEqual([["tenant-a", "session-1", "user-1", "file_change"]]);
    expect(expired).toMatchObject({ tenantId: "tenant-b", approvalId: "approval-9", status: "expired", kind: "permissions" });
    expect(tenantScopes(pool)).toEqual(["tenant-a", "tenant-b"]);
    expect(auditInserts(pool)).toEqual([
      ["tenant-b", "session-1", "user-1", "approval-9", "approval.expired", { reason: "turn_interrupted" }]
    ]);
  });
});

describe("ApprovalStore.sweepExpired", () => {
  function sweepPool(failAudit = false) {
    return acceptAudits(new FakePool(), failAudit).onQuery("FOR UPDATE SKIP LOCKED", (_sql, [limit]) => ({
      rows: [
        approvalRow(["tenant-a", "approval-1", "session-1", "user-1", "runtime-1", "turn-1", "item-1",
          "tools/call", "request-1", "mcp_tool", "A", "A", "expired", null, "{}", T0]),
        approvalRow(["tenant-b", "approval-2", "session-2", "user-2", "runtime-2", "turn-2", "item-2",
          "tools/call", "request-2", "mcp_tool", "B", "B", "expired", null, "{}", T0])
      ].slice(0, Number(limit)),
      rowCount: Math.min(2, Number(limit))
    }));
  }

  test("runs one cross-tenant transaction on the given pool without a tenant scope", async () => {
    const pool = sweepPool();
    const store = new ApprovalStore(pool.asPool());

    expect((await store.sweepExpired()).map(record => record.tenantId)).toEqual(["tenant-a", "tenant-b"]);
    expect((await store.sweepExpired(1)).map(record => record.approvalId)).toEqual(["approval-1"]);
    expect(pool.queries.filter(({ text }) => text.includes("SKIP LOCKED")).map(query => query.values)).toEqual([[500], [1]]);
    expect(tenantScopes(pool)).toEqual([]);
  });

  test("writes one audit event per swept row, each with its row's tenant, before the commit", async () => {
    const pool = sweepPool();
    await new ApprovalStore(pool.asPool()).sweepExpired();
    expect(auditInserts(pool)).toEqual([
      ["tenant-a", "session-1", "user-1", "approval-1", "approval.expired",
        { itemId: "item-1", kind: "mcp_tool", reason: "stale_on_sweep" }],
      ["tenant-b", "session-2", "user-2", "approval-2", "approval.expired",
        { itemId: "item-2", kind: "mcp_tool", reason: "stale_on_sweep" }]
    ]);
    expect(pool.queries.map(({ text }) => text.trim()).at(-1)).toBe("COMMIT");
  });

  test("rolls the whole batch back when one audit event fails", async () => {
    const pool = sweepPool(true);
    await expect(new ApprovalStore(pool.asPool()).sweepExpired()).rejects.toThrow("audit insert failed");
    const texts = pool.queries.map(({ text }) => text.trim());
    expect(texts.at(-1)).toBe("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
  });
});
