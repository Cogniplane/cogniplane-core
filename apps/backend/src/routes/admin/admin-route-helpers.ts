import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { ensureUser } from "../../lib/db.js";
import { apiError, getErrorMessage, notFoundError, validationError } from "../../lib/http-errors.js";
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

  reply.code(400);
  return configError(getErrorMessage(error, fallback));
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

export function parseAdminInput<T extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: T,
  input: unknown
) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400);
    return {
      ok: false as const,
      response: validationError(parsed.error)
    };
  }

  return {
    ok: true as const,
    value: parsed.data
  };
}

export const parseAdminBody = parseAdminInput;
export const parseAdminParams = parseAdminInput;

export function parseAdminCrudBody<T extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: T,
  body: unknown,
  idField: string
) {
  const bodyResult = parseAdminBody(reply, schema, body);
  if (!bodyResult.ok) {
    return bodyResult;
  }

  if (!(bodyResult.value as Record<string, unknown>)[idField]) {
    reply.code(400);
    return {
      ok: false as const,
      response: configError(`${idField} is required.`)
    };
  }

  return bodyResult;
}

export function parseAdminCrudUpdateBody<T extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: T,
  body: unknown,
  idField: string,
  expectedId: string
) {
  const bodyResult = parseAdminBody(reply, schema, body);
  if (!bodyResult.ok) {
    return bodyResult;
  }

  const providedId = (bodyResult.value as Record<string, unknown>)[idField];
  if (providedId !== undefined && providedId !== expectedId) {
    reply.code(400);
    return {
      ok: false as const,
      response: configError(`${idField} must match the route parameter.`)
    };
  }

  return bodyResult;
}

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
