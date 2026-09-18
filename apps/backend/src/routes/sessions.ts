import { canBrowseSessionContent } from "../services/session-access.js";
import { ProjectAccessError } from "../services/project-access.js";
import { SessionExecutionError } from "../services/session-execution-store.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  SESSION_TRASH_RETENTION_DAYS,
  SessionEnvelopeSchema,
  SessionMessagesResponseSchema,
  SessionsListResponseSchema
} from "@cogniplane/shared-types";

import type { AppDependencies } from "../app-dependencies.js";
import { ensureUser } from "../lib/db.js";
import { apiError, notFoundError } from "../lib/http-errors.js";
import { sessionIdParams } from "../lib/route-schemas.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional()
});

const renameSessionSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

const listSessionsQuerySchema = z.object({
  purposes: z.string().optional(),
  status: z.enum(["active", "archived"]).optional()
});

export function buildSessionRouteStores(deps: AppDependencies) {
  return {
    sessions: deps.sessions,
    messages: deps.messages,
    runtimeAdapter: deps.runtimeAdapter,
    limits: deps.limits,
    activeTurns: deps.activeTurns,
    executions: deps.executions,
    auditEvents: deps.auditEvents
  };
}

export type SessionRouteStores = {
  sessions: Pick<AppDependencies["sessions"], "list" | "create" | "rename" | "getReadable" | "getOwned" | "remove" | "setArchived" | "restoreDeleted">
    & { getRetentionDays?: () => number };
  messages: Pick<AppDependencies["messages"], "listBySession">;
  runtimeAdapter: Pick<AppDependencies["runtimeAdapter"], "id" | "hasActiveTurn" | "abortSession" | "purgeSessionData" | "interruptTurn">;
  limits: AppDependencies["limits"];
  activeTurns: AppDependencies["activeTurns"];
  auditEvents: Pick<AppDependencies["auditEvents"], "create">;
  executions: Pick<AppDependencies["executions"], "stop">;
};

export async function registerSessionRoutes(
  app: FastifyInstance,
  stores: SessionRouteStores
): Promise<void> {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectAccessError) return reply.code(error.status).send(apiError(error.code, error.message));
      if (error instanceof SessionExecutionError) return reply.code(error.statusCode).send(apiError(error.code, error.message));
      throw error;
    });
    await registerScopedSessionRoutes(routes, stores);
  });
}

async function registerScopedSessionRoutes(
  app: FastifyInstance,
  stores: SessionRouteStores
): Promise<void> {
  app.get("/sessions", async (request, reply) => {
    await ensureUser(app.db, request.auth.userId);
    const { userId, tenantId } = request.auth;

    // `?purposes=` controls which session purposes are returned.
    //   omitted     → only `purpose = 'normal'` (the chat sidebar default;
    //                 keeps non-chat runs like scheduled jobs out of the list).
    //   all         → every active session.
    //   csv list    → exact set, e.g. `?purposes=normal,scheduled`.
    const queryResult = parseRequestInput(reply, listSessionsQuerySchema, request.query ?? {});
    if (!queryResult.ok) {
      return queryResult.response;
    }
    let purposes: string[] | "all" | undefined;
    if (queryResult.value.purposes !== undefined) {
      const trimmed = queryResult.value.purposes.trim();
      if (trimmed === "all") {
        purposes = "all";
      } else if (trimmed.length > 0) {
        purposes = trimmed
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
      }
    }

    const sessions = await stores.sessions.list(tenantId, userId, { purposes, ...(queryResult.value.status ? { status: queryResult.value.status } : {}) });
    const running = stores.activeTurns?.snapshot();
    const decoratedSessions = sessions.map((session) => {
      const isRunning = running?.has(session.sessionId) ?? false;
      const startedAt = isRunning ? stores.activeTurns?.startedAt(session.sessionId) : undefined;
      const turn = isRunning ? stores.activeTurns?.identity(session.sessionId) : undefined;
      return {
        ...session,
        ...(turn ? { latestTurnId: turn.messageId, latestTurnSequence: turn.sequence } : {}),
        hasTurnFailed: !isRunning && session.hasTurnFailed === true,
        isRunning,
        activeTurnStartedAt: startedAt === undefined ? undefined : new Date(startedAt).toISOString()
      };
    });
    return serialize(SessionsListResponseSchema, {
      sessions: decoratedSessions,
      trashRetentionDays: stores.sessions.getRetentionDays?.() ?? SESSION_TRASH_RETENTION_DAYS
    });
  });

  app.post("/sessions", async (request, reply) => {
    await ensureUser(app.db, request.auth.userId);
    const parsedResult = parseRequestInput(reply, createSessionSchema, request.body ?? {});
    if (!parsedResult.ok) {
      return parsedResult.response;
    }

    const rateLimitError = await stores.limits.consumeRateLimit({
      resource: "session_create",
      userId: request.auth.userId,
      tenantId: request.auth.tenantId
    });
    if (rateLimitError) {
      reply.code(429);
      reply.header("retry-after", Math.max(1, Math.ceil(rateLimitError.retryAfterMs / 1000)));
      return rateLimitError;
    }

    const { userId, tenantId } = request.auth;
    const session = await stores.sessions.create(
      tenantId,
      userId,
      parsedResult.value.name ?? "New session"
    );
    reply.code(201);
    return serialize(SessionEnvelopeSchema, { session });
  });

  app.put("/sessions/:sessionId/name", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseRequestInput(reply, renameSessionSchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { userId, tenantId } = request.auth;
    const session = await stores.sessions.rename(
      tenantId,
      paramsResult.value.sessionId,
      userId,
      bodyResult.value.name
    );

    if (!session) {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    return serialize(SessionEnvelopeSchema, { session });
  });

  for (const action of ["archive", "restore"] as const) {
    app.post(`/sessions/:sessionId/${action}`, async (request, reply) => {
      const params = parseRequestInput(reply, sessionIdParams, request.params);
      if (!params.ok) return params.response;
      const { tenantId, userId } = request.auth;
      const { sessionId } = params.value;
      if (action === "restore") {
        const restored = await stores.sessions.restoreDeleted(tenantId, sessionId, userId);
        if (restored) {
          try {
            await stores.auditEvents.create({
              tenantId,
              sessionId,
              userId,
              type: "session.restored",
              payload: { status: restored.status, fromTrash: true }
            });
          } catch (error) {
            request.log.warn({ error, sessionId }, "Failed to record session restore activity");
          }
          return serialize(SessionEnvelopeSchema, { session: restored });
        }
      }
      const session = await stores.sessions.getReadable(tenantId, sessionId, userId);
      if (!session || session.status === "deleted") {
        reply.code(404);
        return notFoundError("session_not_found");
      }
      const archived = action === "archive";
      // Shared retries must recheck current mutation authority in the store.
      // The conditional UPDATE rejects an unchanged state without a new audit.
      if (!session.projectId && session.status === (archived ? "archived" : "active")) {
        return serialize(SessionEnvelopeSchema, { session });
      }
      if (stores.runtimeAdapter.hasActiveTurn(sessionId) || stores.activeTurns?.isBusy(sessionId)) {
        reply.code(409);
        return apiError("session_busy", "Wait for the current turn to finish before archiving or restoring this session.");
      }
      // Share the interactive turn reservation so archive cannot overlap a new turn.
      stores.activeTurns?.mark(sessionId);
      try {
        const updated = await stores.sessions.setArchived(tenantId, sessionId, userId, archived);
        if (!updated) {
          reply.code(409);
          return apiError("session_archive_conflict", "The session changed or has a pending approval. Refresh and try again.");
        }
        // Match interrupt telemetry: an audit failure does not undo a completed transition.
        try {
          await stores.auditEvents.create({
            tenantId,
            sessionId,
            userId,
            type: archived ? "session.archived" : "session.restored",
            payload: { previousStatus: session.status, status: updated.status, purpose: updated.purpose ?? "normal" }
          });
        } catch (err) {
          request.log.warn({ err, sessionId, action }, "Failed to record session lifecycle audit event");
        }
        return serialize(SessionEnvelopeSchema, { session: updated });
      } finally {
        stores.activeTurns?.clear(sessionId);
      }
    });
  }

  // Shared cancellation fences execution in the database. The worker observes
  // it through dispatch authorization and its heartbeat, on any replica.
  app.post("/sessions/:sessionId/interrupt", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) return paramsResult.response;

    const { userId, tenantId } = request.auth;
    const { sessionId } = paramsResult.value;

    const session = await stores.sessions.getReadable(tenantId, sessionId, userId);
    if (!session) {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    const owningAdapter = stores.runtimeAdapter;

    if (session.projectId) {
      const stopped = await stores.executions.stop({ tenantId, sessionId, userId });
      if (!stopped) {
        reply.code(409);
        return apiError("no_active_turn", "There is no active turn you can interrupt in this session.");
      }
      // Durable fencing handles another replica. Signal the local runtime too,
      // so Stop does not wait for its next heartbeat to release in-process state.
      try {
        await owningAdapter.interruptTurn({ tenantId, sessionId, userId });
      } catch (error) {
        request.log.warn({ err: error, sessionId }, "Failed to signal the local project runtime after fencing");
      }
      return { status: "interrupted" };
    }

    if (!owningAdapter.interruptTurn) {
      reply.code(501);
      return apiError("interrupt_not_supported", "This runtime does not support interrupting a turn.");
    }

    const result = await owningAdapter.interruptTurn({ tenantId, sessionId, userId });

    if (result === "no_active_turn") {
      reply.code(409);
      return apiError("no_active_turn", "There is no active turn to interrupt for this session.");
    }

    // Telemetry — useful for "are users hitting Stop a lot?" (signal that
    // prompts/skills need work). Best-effort; route still returns 200 on
    // audit write failure.
    try {
      await stores.auditEvents.create({
        tenantId,
        sessionId,
        userId,
        type: "turn.interrupted",
        payload: { adapter: owningAdapter.id }
      });
    } catch (err) {
      request.log.warn({ err, sessionId }, "Failed to record turn.interrupted audit event");
    }

    reply.code(200);
    return { status: "interrupted" };
  });

  app.delete("/sessions/:sessionId", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const { userId, tenantId } = request.auth;
    const { sessionId } = paramsResult.value;
    const removed = await stores.sessions.remove(tenantId, sessionId, userId);

    if (!removed) {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    // abortSession also cleans up stale runtime_sessions rows when the
    // adapter holds no in-memory state for this session.
    try {
      await stores.runtimeAdapter.abortSession({
        tenantId,
        sessionId,
        userId
      });
    } catch (err) {
      request.log.warn(
        { err, sessionId },
        "Runtime cleanup failed after session deletion"
      );
    }

    // Keep the conversation and its durable runtime state during the
    // configured recovery period. The retention worker purges them after expiry.
    try {
      await stores.auditEvents.create({
        tenantId,
        sessionId,
        userId,
        type: "session.deleted",
        payload: { fromTrash: true }
      });
    } catch (error) {
      request.log.warn({ error, sessionId }, "Failed to record session deletion activity");
    }

    reply.code(204);
    return null;
  });

  app.get("/sessions/:sessionId/messages", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const { userId, tenantId } = request.auth;
    const { sessionId } = paramsResult.value;
    const session = await stores.sessions.getReadable(tenantId, sessionId, userId);

    if (!session || !canBrowseSessionContent(session)) {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    // Bounded read: newest-N messages with tool text truncated in the
    // projection (see MessageStore.listBySession). `hasMore` tells the client
    // older turns were withheld rather than silently dropping them.
    const { messages, hasMore } = await stores.messages.listBySession(tenantId, sessionId, userId);

    reply.header("cache-control", "private, no-store");
    return serialize(SessionMessagesResponseSchema, {
      session,
      messages,
      hasMore
    });
  });
}
