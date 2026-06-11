import { test, expect } from "vitest";

import {
  buildApprovalRequest,
  respondToApprovalRequest,
  type PendingApprovalRecord
} from "./runtime-approval-coordinator.js";

type RuntimeCtx = { activeTurn: { responseId: string | null } | null };

function ctx(responseId: string | null = "active-turn-id"): RuntimeCtx {
  return { activeTurn: { responseId } };
}

test("buildApprovalRequest returns null for unknown methods", () => {
  const result = buildApprovalRequest(ctx(), { id: 1, method: "noop" });
  expect(result).toBe(null);
});

test("item/commandExecution/requestApproval: uses provided ids and includes cwd in summary", () => {
  const result = buildApprovalRequest(ctx(), {
    id: "rid-1",
    method: "item/commandExecution/requestApproval",
    params: { command: "ls -la", cwd: "/tmp", approvalId: "apv", itemId: "itm", turnId: "turn-x" }
  });
  expect(result).toBeTruthy();
  expect(result!.kind).toBe("command_execution");
  expect(result!.approvalId).toBe("apv");
  expect(result!.itemId).toBe("itm");
  expect(result!.turnId).toBe("turn-x");
  expect(result!.command).toBe("ls -la");
  expect(result!.cwd).toBe("/tmp");
  expect(result!.summary).toMatch(/ls -la/);
  expect(result!.summary).toMatch(/cwd: \/tmp/);
  // pending mirror points back at the JSON-RPC request
  expect(result!.pending.requestId).toBe("rid-1");
  expect(result!.pending.method).toBe("item/commandExecution/requestApproval");
});

test("item/commandExecution/requestApproval: missing ids fall back to generated/active turn", () => {
  const result = buildApprovalRequest(ctx("turn-from-active"), {
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: {} // no approvalId, itemId, turnId, command, cwd
  });
  expect(result).toBeTruthy();
  // approvalId is generated (uuid), itemId defaults to approvalId, turnId falls back
  // to the active turn responseId.
  expect(result!.approvalId.length > 0).toBeTruthy();
  expect(result!.itemId).toBe(result!.approvalId);
  expect(result!.turnId).toBe("turn-from-active");
  expect(result!.command).toBe(null);
  expect(result!.cwd).toBe(null);
  // No cwd → summary is empty (no "cwd:" line)
  expect(result!.summary).toBe("");
});

test("item/commandExecution/requestApproval: empty-string params are coerced to null", () => {
  const result = buildApprovalRequest(ctx(), {
    id: 1,
    method: "item/commandExecution/requestApproval",
    // empty strings should be treated as missing (str() returns null)
    params: { command: "", cwd: "", approvalId: "" }
  });
  expect(result).toBeTruthy();
  // empty approvalId triggers fallback to a generated id
  expect(result!.approvalId).not.toBe("");
});

test("item/fileChange/requestApproval: kind=file_change, defaults summary when no reason", () => {
  const result = buildApprovalRequest(ctx(), {
    id: 1,
    method: "item/fileChange/requestApproval",
    params: { itemId: "patch-1", turnId: "turn-1" }
  });
  expect(result).toBeTruthy();
  expect(result!.kind).toBe("file_change");
  expect(result!.approvalId).toBe("patch-1:file-change");
  expect(result!.turnId).toBe("turn-1");
  expect(result!.itemId).toBe("patch-1");
  expect(result!.command).toBe(null);
  expect(result!.cwd).toBe(null);
  expect(result!.summary).toMatch(/modify files/i);
});

test("item/fileChange/requestApproval: uses provided reason when present", () => {
  const result = buildApprovalRequest(ctx(), {
    id: 1,
    method: "item/fileChange/requestApproval",
    params: { itemId: "p", reason: "rewrites README" }
  });
  expect(result!.summary).toBe("rewrites README");
  // turnId falls back to itemId when not provided
  expect(result!.turnId).toBe("p");
});

test("item/permissions/requestApproval: kind=permissions, default summary if no reason", () => {
  const result = buildApprovalRequest(ctx(), {
    id: 1,
    method: "item/permissions/requestApproval",
    params: { itemId: "perm-1" }
  });
  expect(result).toBeTruthy();
  expect(result!.kind).toBe("permissions");
  expect(result!.approvalId).toBe("perm-1:permissions");
  expect(result!.turnId).toBe("perm-1");
  expect(result!.summary).toMatch(/requested additional permissions/i);
});

// --- respondToApprovalRequest variants ---

type Capture = {
  responses: Array<{ id: string | number; result: Record<string, unknown> }>;
  errors: Array<{ id: string | number; code: number; message: string }>;
};

function captureProcess(): Capture & {
  sendResponse: (id: string | number, result: Record<string, unknown>) => void;
  sendError: (id: string | number, code: number, message: string) => void;
} {
  const cap: Capture = { responses: [], errors: [] };
  return {
    ...cap,
    sendResponse: (id, result) => cap.responses.push({ id, result }),
    sendError: (id, code, message) => cap.errors.push({ id, code, message })
  };
}

const pending = (overrides: Partial<PendingApprovalRecord> = {}): PendingApprovalRecord => ({
  approvalId: "ap",
  requestId: "rid",
  method: "item/commandExecution/requestApproval",
  itemId: "it",
  kind: "command_execution",
  ...overrides
});

test("respond: item/commandExecution + approve => decision: accept", () => {
  const proc = captureProcess();
  respondToApprovalRequest(proc, pending(), "approve");
  expect(proc.responses).toEqual([{ id: "rid", result: { decision: "accept" } }]);
});

test("respond: item/commandExecution + reject => decision: decline", () => {
  const proc = captureProcess();
  respondToApprovalRequest(proc, pending(), "reject");
  expect(proc.responses).toEqual([{ id: "rid", result: { decision: "decline" } }]);
});

test("respond: item/fileChange + approve => decision: accept", () => {
  const proc = captureProcess();
  respondToApprovalRequest(
    proc,
    pending({ method: "item/fileChange/requestApproval" }),
    "approve"
  );
  expect(proc.responses).toEqual([{ id: "rid", result: { decision: "accept" } }]);
});

test("respond: item/permissions + approve => empty permissions object", () => {
  const proc = captureProcess();
  respondToApprovalRequest(
    proc,
    pending({ method: "item/permissions/requestApproval" }),
    "approve"
  );
  expect(proc.responses).toEqual([{ id: "rid", result: { permissions: {} } }]);
  expect(proc.errors.length).toBe(0);
});

test("respond: item/permissions + reject => sendError -32001", () => {
  const proc = captureProcess();
  respondToApprovalRequest(
    proc,
    pending({ method: "item/permissions/requestApproval" }),
    "reject"
  );
  expect(proc.responses.length).toBe(0);
  expect(proc.errors.length).toBe(1);
  expect(proc.errors[0].code).toBe(-32001);
});

test("respond: unsupported method => sendError -32601", () => {
  const proc = captureProcess();
  respondToApprovalRequest(proc, pending({ method: "totally/unknown" }), "approve");
  expect(proc.responses.length).toBe(0);
  expect(proc.errors[0].code).toBe(-32601);
  expect(proc.errors[0].message).toMatch(/Unsupported approval request/);
});
