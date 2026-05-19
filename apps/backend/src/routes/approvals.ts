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
    runtimeAdapters: deps.runtimeAdapters
  };
}

export type ApprovalRouteStores = ReturnType<typeof buildApprovalRouteStores>;

const RESOLVED_APPROVAL_TTL_MS = 5 * 60 * 1000;

// Cache recently resolved approval IDs so retried decisions return the
// original outcome instead of 404.
//
// Keyed by `tenantId:approvalId` so a tenant that probes another tenant's
// approval IDs cannot get a positive "resolved" signal — even if approval IDs
// are 128-bit UUIDs that are practically unguessable, scoping the cache by
// tenant removes the cross-tenant leak by construction.
//
// NOTE: This cache is per-process. In a multi-replica deployment a retried
// request that lands on a different instance still gets a 404 — it degrades
// gracefully (the frontend shows an error instead of silently double-approving).
// To make idempotency work across replicas, replace this Map with a Redis key
// with the same TTL (RESOLVED_APPROVAL_TTL_MS).
export type RecentlyResolvedCache = {
  remember(tenantId: string, approvalId: string): void;
  wasRecentlyResolved(tenantId: string, approvalId: string): boolean;
};

export function createRecentlyResolvedCache(ttlMs: number = RESOLVED_APPROVAL_TTL_MS): RecentlyResolvedCache {
  const entries = new Map<string, number>(); // `${tenantId}:${approvalId}` → expiresAt

  function compositeKey(tenantId: string, approvalId: string): string {
    return `${tenantId}:${approvalId}`;
  }

  return {
    remember(tenantId, approvalId) {
      entries.set(compositeKey(tenantId, approvalId), Date.now() + ttlMs);
      const now = Date.now();
      for (const [key, expiresAt] of entries) {
        if (expiresAt <= now) entries.delete(key);
      }
    },
    wasRecentlyResolved(tenantId, approvalId) {
      const key = compositeKey(tenantId, approvalId);
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

    // Iterate registered adapters and forward the decision to whichever one
    // owns the pending approval. Map insertion order is Codex → Claude (set
    // in build-runtime-adapters.ts), so Codex is tried first as before.
    let result: "resolved" | "missing" = "missing";
    for (const adapter of Object.values(stores.runtimeAdapters)) {
      if (!adapter?.resolveApproval) continue;
      const adapterResult = await adapter.resolveApproval({
        tenantId: request.auth.tenantId,
        approvalId,
        userId: request.auth.userId,
        decision,
        rememberForTurn
      });
      if (adapterResult === "resolved") {
        result = "resolved";
        break;
      }
    }

    if (result === "missing") {
      // Return the original outcome on retry rather than 404.
      if (recentlyResolved.wasRecentlyResolved(request.auth.tenantId, approvalId)) {
        return { status: "resolved" };
      }
      reply.code(404);
      return notFoundError("approval_not_found");
    }

    recentlyResolved.remember(request.auth.tenantId, approvalId);
    return { status: "resolved" };
  });
}
