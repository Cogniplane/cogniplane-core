import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApprovalDecisionRequestSchema, ApprovalsListResponseSchema } from "@cogniplane/shared-types";

import type { AppDependencies } from "../app-dependencies.js";
import { apiError, notFoundError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { sessionIdParams } from "../lib/route-schemas.js";
import { serialize } from "../lib/serialize-response.js";
import { canBrowseSessionContent } from "../services/session-access.js";
import { approvalAllowsTurnScope } from "../services/policy/policy-approval-proof.js";

export function buildApprovalRouteStores(deps: AppDependencies) {
  return {
    approvals: deps.approvals,
    sessions: deps.sessions,
    runtimeAdapter: deps.runtimeAdapter
  };
}

export type ApprovalRouteStores = {
  approvals: Pick<AppDependencies["approvals"], "listPending">;
  sessions: Pick<AppDependencies["sessions"], "getReadable">;
  runtimeAdapter: Pick<AppDependencies["runtimeAdapter"], "resolveApproval">;
};

export async function registerApprovalRoutes(
  app: FastifyInstance,
  stores: ApprovalRouteStores
): Promise<void> {
  app.get("/sessions/:sessionId/approvals", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const { userId, tenantId } = request.auth;
    // Same read access as the session's messages. The list holds only the
    // caller's own approvals: those are the ones the caller can decide.
    const session = await stores.sessions.getReadable(tenantId, paramsResult.value.sessionId, userId);
    if (!session || !canBrowseSessionContent(session)) {
      return reply.code(404).send(notFoundError("session_not_found"));
    }
    reply.header("cache-control", "private, no-store");
    return serialize(ApprovalsListResponseSchema, {
      approvals: (await stores.approvals.listPending(
        tenantId,
        paramsResult.value.sessionId,
        userId
      )).map((approval) => ({ ...approval, allowForTurn: approvalAllowsTurnScope(approval) }))
    });
  });

  app.post("/approvals/:approvalId/decision", async (request, reply) => {
    const paramsResult = parseRequestInput(
      reply,
      z.object({ approvalId: z.string().min(1) }),
      request.params
    );
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseRequestInput(reply, ApprovalDecisionRequestSchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { approvalId } = paramsResult.value;

    const { decision, rememberForTurn } = bodyResult.value;

    // The decision path compares a repeated request with the saved decision,
    // so a retry gets the same answer on each replica and after a restart.
    const result = await stores.runtimeAdapter.resolveApproval({
      tenantId: request.auth.tenantId,
      approvalId,
      userId: request.auth.userId,
      decision,
      rememberForTurn
    });

    if (result === "missing") {
      reply.code(404);
      return notFoundError("approval_not_found");
    }
    if (result === "conflict") {
      reply.code(409);
      return apiError("approval_conflict", "This approval already has a different decision.");
    }
    return { status: "resolved" };
  });
}
