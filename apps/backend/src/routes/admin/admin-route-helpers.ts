import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ensureUser } from "../../lib/db.js";
import { apiError, notFoundError } from "../../lib/http-errors.js";
import { AdminConfigError } from "../../services/admin-config-error.js";
import type { AuditEventInput, AuditEventStore } from "../../services/audit-event-store.js";
import type { AuditEventType } from "../../services/audit-event-types.js";

export { AdminIdSchema as adminIdSchema } from "@cogniplane/shared-types";

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

export function respondAdminNotFound(reply: FastifyReply, errorCode: string) {
  reply.code(404);
  return notFoundError(errorCode);
}

/**
 * The audit event of an admin change, for a store that writes it in the
 * change's transaction: the acting admin, the request's address and agent,
 * and no session.
 */
export function adminAuditEvent(
  request: FastifyRequest,
  type: AuditEventType,
  payload: Record<string, unknown>
): AuditEventInput {
  return {
    tenantId: request.auth.tenantId,
    sessionId: null,
    userId: request.auth.userId,
    type,
    payload,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? null
  };
}

/**
 * Writes an admin audit event in a transaction of its own. Only for an admin
 * action with no database change to join, such as a runtime teardown:
 * `audit-event-sites.test.ts` lists each call.
 */
export async function createAdminAuditEvent(
  auditEvents: Pick<AuditEventStore, "create">,
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
