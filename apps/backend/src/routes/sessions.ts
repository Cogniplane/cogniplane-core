import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
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
  purposes: z.string().optional()
});

export function buildSessionRouteStores(deps: AppDependencies) {
  return {
    sessions: deps.sessions,
    messages: deps.messages,
    runtimeAdapter: deps.runtimeAdapter,
    limits: deps.limits,
    activeTurns: deps.activeTurns,
    auditEvents: deps.auditEvents
  };
}

export type SessionRouteStores = ReturnType<typeof buildSessionRouteStores>;

export async function registerSessionRoutes(
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

    const sessions = await stores.sessions.list(tenantId, userId, { purposes });
    const running = stores.activeTurns?.snapshot();
    if (running && running.size > 0) {
      for (const session of sessions) {
        if (running.has(session.sessionId)) session.isRunning = true;
      }
    }
    return serialize(SessionsListResponseSchema, { sessions });
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

  // Stop button — interrupt the in-flight turn while keeping the runtime warm.
  // Routes to the adapter holding in-memory state for the session (mirrors
  // DELETE /sessions/:sessionId). 200 on stop dispatched, 409 when nothing
  // was running.
  app.post("/sessions/:sessionId/interrupt", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) return paramsResult.response;

    const { userId, tenantId } = request.auth;
    const { sessionId } = paramsResult.value;

    const session = await stores.sessions.getOwned(tenantId, sessionId, userId);
    if (!session) {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    const owningAdapter = stores.runtimeAdapter;

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

    // Durable per-session runtime data (Deep Agents checkpointer threads, …)
    // is only deleted here — never from abortSession, which also fires on
    // idle teardown. Purge is idempotent and works with no in-memory state.
    try {
      await stores.runtimeAdapter.purgeSessionData({ tenantId, sessionId, userId });
    } catch (err) {
      request.log.warn(
        { err, sessionId, adapter: stores.runtimeAdapter.id },
        "Failed to purge per-session runtime data after session deletion"
      );
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
    const session = await stores.sessions.getOwned(tenantId, sessionId, userId);

    if (!session || session.status !== "active") {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    return serialize(SessionMessagesResponseSchema, {
      session,
      messages: await stores.messages.listBySession(tenantId, sessionId, userId)
    });
  });
}
