import Fastify from "fastify";
import { expect, onTestFinished, test, vi } from "vitest";

import { registerApprovalRoutes, type ApprovalRouteStores } from "./approvals.js";

type DecisionResult = "resolved" | "missing" | "conflict";

async function decisionApp(results: DecisionResult[]) {
  const resolveApproval = vi.fn(async (_input: Parameters<ApprovalRouteStores["runtimeAdapter"]["resolveApproval"]>[0]) => {
    const result = results.shift();
    if (!result) throw new Error("unexpected decision request");
    return result;
  });
  const app = Fastify();
  onTestFinished(() => app.close());
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId: "tenant-a", userId: "user-a", role: "member", isAdmin: false };
  });
  await registerApprovalRoutes(app, {
    approvals: { listPending: async () => [] },
    sessions: { getReadable: async () => null },
    runtimeAdapter: { resolveApproval }
  });
  const decide = (payload: Record<string, unknown>, approvalId = "approval-1") =>
    app.inject({ method: "POST", url: `/approvals/${approvalId}/decision`, payload });
  return { decide, resolveApproval };
}

test("forwards the authenticated identity and the request body, and returns 200 when resolved", async () => {
  const { decide, resolveApproval } = await decisionApp(["resolved"]);

  const response = await decide({ decision: "approve", rememberForTurn: true, tenantId: "tenant-b", userId: "user-b" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "resolved" });
  expect(resolveApproval).toHaveBeenCalledExactlyOnceWith({
    tenantId: "tenant-a", userId: "user-a", approvalId: "approval-1", decision: "approve", rememberForTurn: true
  });
});

test("returns 404 approval_not_found when the caller cannot decide the approval", async () => {
  const { decide } = await decisionApp(["missing"]);

  const response = await decide({ decision: "reject" });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "approval_not_found" });
});

test("returns 409 approval_conflict when the approval already has a different decision", async () => {
  const { decide } = await decisionApp(["conflict"]);

  const response = await decide({ decision: "reject" });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({
    error: "approval_conflict", message: "This approval already has a different decision."
  });
});

test("asks the decision path again on each retry instead of returning an earlier success", async () => {
  const { decide, resolveApproval } = await decisionApp(["resolved", "conflict", "missing", "resolved"]);

  expect((await decide({ decision: "approve" })).statusCode).toBe(200);
  expect((await decide({ decision: "reject" })).statusCode).toBe(409);
  expect((await decide({ decision: "approve" })).statusCode).toBe(404);
  expect((await decide({ decision: "approve" })).statusCode).toBe(200);
  expect(resolveApproval).toHaveBeenCalledTimes(4);
});

test("rejects an invalid decision before it reaches the decision path", async () => {
  const { decide, resolveApproval } = await decisionApp([]);

  expect((await decide({ decision: "maybe" })).statusCode).toBe(400);
  expect(resolveApproval).not.toHaveBeenCalled();
});
