import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApprovalDecisionRequestSchema, ApprovalsListResponseSchema } from "@cogniplane/shared-types";

import type { AppDependencies } from "../app-dependencies.js";
import { notFoundError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { sessionIdParams } from "../lib/route-schemas.js";
import { serialize } from "../lib/serialize-response.js";

export function buildApprovalRouteStores(deps: AppDependencies) {
  return {
    approvals: deps.approvals,
    runtimeAdapter: deps.runtimeAdapter
  };
}

export type ApprovalRouteStores = {
  approvals: Pick<AppDependencies["approvals"], "listPending">;
  runtimeAdapter: Pick<AppDependencies["runtimeAdapter"], "resolveApproval">;
};

const RESOLVED_APPROVAL_TTL_MS = 5 * 60 * 1000;

// Retries are scoped to the initiating user, tenant and approval. This cache
// is local to one process; a retry on another replica can still return 404.
export type RecentlyResolvedCache = {
  remember(tenantId: string, userId: string, approvalId: string): void;
  wasRecentlyResolved(tenantId: string, userId: string, approvalId: string): boolean;
};

export function createRecentlyResolvedCache(ttlMs: number = RESOLVED_APPROVAL_TTL_MS): RecentlyResolvedCache {
  const entries = new Map<string, number>(); // Identity tuple → expiry

  function compositeKey(tenantId: string, userId: string, approvalId: string): string {
    return JSON.stringify([tenantId, userId, approvalId]);
  }

  return {
    remember(tenantId, userId, approvalId) {
      entries.set(compositeKey(tenantId, userId, approvalId), Date.now() + ttlMs);
      const now = Date.now();
      for (const [key, expiresAt] of entries) {
        if (expiresAt <= now) entries.delete(key);
      }
    },
    wasRecentlyResolved(tenantId, userId, approvalId) {
      const key = compositeKey(tenantId, userId, approvalId);
      const expiresAt = entries.get(key);
      if (expiresAt === undefined) return false;
      if (expiresAt <= Date.now()) {
        entries.delete(key);
        return false;
      }
      return true;
    }
  };
}

export async function registerApprovalRoutes(
  app: FastifyInstance,
  stores: ApprovalRouteStores
): Promise<void> {
  const recentlyResolved = createRecentlyResolvedCache();

  app.get("/sessions/:sessionId/approvals", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const { userId, tenantId } = request.auth;
    return serialize(ApprovalsListResponseSchema, {
      approvals: await stores.approvals.listPending(
        tenantId,
        paramsResult.value.sessionId,
        userId
      )
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

    // Forward the decision to the one checkpointed approval path.
    const result = await stores.runtimeAdapter.resolveApproval({
      tenantId: request.auth.tenantId,
      approvalId,
      userId: request.auth.userId,
      decision,
      rememberForTurn
    });

    if (result === "missing") {
      // Return the original outcome on retry rather than 404.
      if (recentlyResolved.wasRecentlyResolved(request.auth.tenantId, request.auth.userId, approvalId)) {
        return { status: "resolved" };
      }
      reply.code(404);
      return notFoundError("approval_not_found");
    }

    recentlyResolved.remember(request.auth.tenantId, request.auth.userId, approvalId);
    return { status: "resolved" };
  });
}
