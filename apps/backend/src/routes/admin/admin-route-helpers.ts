import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { ensureUser } from "../../lib/db.js";
import { apiError, notFoundError } from "../../lib/http-errors.js";
import { parseRequestInput } from "../../lib/route-validation.js";
import { AdminConfigError } from "../../services/admin-config-error.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { AuditEventType } from "../../services/audit-event-types.js";

export const adminIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/);

export function configError(message: string) {
  return apiError("invalid_config", message);
}

function conflictError(message: string) {
  return apiError("conflict", message);
}

function isUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export function respondAdminMutationError(reply: FastifyReply, error: unknown, fallback: string) {
  if (isUniqueViolation(error)) {
    reply.code(409);
    return conflictError(error.constraint ? `${fallback} (${error.constraint}).` : fallback);
  }

  if (error instanceof AdminConfigError) {
    reply.code(400);
    return configError(error.message);
  }

  // Unexpected error (Postgres, SDK, fs, ...): rethrow so the global error
  // handler logs the real cause and returns an opaque 500. Raw internal
  // error strings must not reach the client.
  throw error;
}

export async function requireAdmin(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  await ensureUser(app.db, request.auth.userId);
  if (!request.auth.isAdmin) {
    reply.code(403).send(apiError("admin_required"));
    return false;
  }

  return true;
}

export function withAdmin(
  app: FastifyInstance,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await requireAdmin(app, request, reply))) {
      return;
    }

    return handler(request, reply);
  };
}

// Semantic names for the shared request-input parser at admin call sites.
export const parseAdminBody = parseRequestInput;
export const parseAdminParams = parseRequestInput;

export function respondAdminNotFound(reply: FastifyReply, errorCode: string) {
  reply.code(404);
  return notFoundError(errorCode);
}

export async function createAdminAuditEvent(
  auditEvents: AuditEventStore,
  input: {
    tenantId: string;
    userId: string;
    type: AuditEventType;
    payload: Record<string, unknown>;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
) {
  await auditEvents.create({
    tenantId: input.tenantId,
    sessionId: null,
    userId: input.userId,
    type: input.type,
    payload: input.payload,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent
  });
}
