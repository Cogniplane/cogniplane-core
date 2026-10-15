import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  MemoriesResponseSchema,
  MemoryDeleteRequestSchema,
  MemoryIdSchema,
  MemoryResponseSchema,
  MemoryUpdateRequestSchema,
  type MemoryScope
} from "@cogniplane/shared-types";

import { apiError, notFoundError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import {
  MemoryConflictError,
  MemoryNotFoundError,
  type MemoryRecord,
  type MemoryStore
} from "../services/memory-store.js";

// A user lists, edits and deletes their own long-term memories here. The agent
// can only propose new ones, and the user approves the exact text in the chat.
// Every query takes the tenant and the user from the authenticated request, so
// one member never reads or changes another member's memories.

export type MemoryRouteStores = {
  memories: Pick<MemoryStore, "list" | "updateByUser" | "removeById">;
  auditEvents: Pick<AuditEventStore, "create">;
};

const idParams = z.object({ memoryId: MemoryIdSchema });

const scopeChanged = () =>
  apiError("memory_scope_changed", "Your account or organization changed. Reload before you change a memory.");

function scopeMismatch(provided: MemoryScope, actual: MemoryScope): boolean {
  return provided.tenantId !== actual.tenantId || provided.userId !== actual.userId;
}

function toMemory(record: MemoryRecord) {
  return {
    id: record.memoryId,
    name: record.slug,
    content: record.content,
    metadata: record.metadata,
    version: record.version,
    provenance: record.provenance,
    approvedAt: record.approvedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export async function registerMemoryRoutes(
  app: FastifyInstance,
  stores: MemoryRouteStores
): Promise<void> {
  app.get("/me/memories", async (request, reply) => {
    const { tenantId, userId } = request.auth;
    const { memories, total } = await stores.memories.list(tenantId, userId);
    reply.header("cache-control", "private, no-store");
    return serialize(MemoriesResponseSchema, { scope: { tenantId, userId }, memories: memories.map(toMemory), total });
  });

  app.put("/me/memories/:memoryId", async (request, reply) => {
    const { tenantId, userId } = request.auth;
    const params = parseRequestInput(reply, idParams, request.params);
    if (!params.ok) return params.response;
    const body = parseRequestInput(reply, MemoryUpdateRequestSchema, request.body);
    if (!body.ok) return body.response;
    if (scopeMismatch(body.value.scope, { tenantId, userId })) {
      reply.code(409);
      return scopeChanged();
    }

    let record: MemoryRecord;
    try {
      record = await stores.memories.updateByUser(tenantId, userId, params.value.memoryId, {
        content: body.value.content,
        expectedVersion: body.value.version
      });
    } catch (error) {
      if (error instanceof MemoryNotFoundError) {
        reply.code(404);
        return notFoundError("memory_not_found");
      }
      if (error instanceof MemoryConflictError) {
        reply.code(409);
        return apiError("memory_conflict", "This memory changed. Reload it before you edit it.");
      }
      throw error;
    }

    await stores.auditEvents.create({
      tenantId,
      sessionId: null,
      userId,
      type: "user.memory.updated",
      payload: { memoryId: record.memoryId, name: record.slug, version: record.version }
    });
    reply.header("cache-control", "private, no-store");
    return serialize(MemoryResponseSchema, { scope: { tenantId, userId }, memory: toMemory(record) });
  });

  app.delete("/me/memories/:memoryId", async (request, reply) => {
    const { tenantId, userId } = request.auth;
    const params = parseRequestInput(reply, idParams, request.params);
    if (!params.ok) return params.response;
    const body = parseRequestInput(reply, MemoryDeleteRequestSchema, request.body);
    if (!body.ok) return body.response;
    if (scopeMismatch(body.value.scope, { tenantId, userId })) {
      reply.code(409);
      return scopeChanged();
    }

    const removed = await stores.memories.removeById(tenantId, userId, params.value.memoryId);
    if (!removed) {
      reply.code(404);
      return notFoundError("memory_not_found");
    }

    await stores.auditEvents.create({
      tenantId,
      sessionId: null,
      userId,
      type: "user.memory.deleted",
      payload: { memoryId: params.value.memoryId, name: removed.slug }
    });
    reply.code(204);
    return null;
  });
}
