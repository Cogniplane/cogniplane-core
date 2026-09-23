import { SessionListCursorSchema } from "../services/session-store.js";
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
import { openSseResponse } from "../lib/open-sse-response.js";
import { SseWriter } from "../services/sse-writer.js";
import type { SequencedTurnEvent } from "../services/turn-event-log.js";
import type { TurnCoordinationBus } from "../services/turn-coordination-bus.js";

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional()
});

const renameSessionSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

const listSessionsQuerySchema = z.object({
  purposes: z.string().optional(),
  status: z.enum(["active", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1000).transform((value, ctx) => {
    try {
      return SessionListCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid session cursor" });
      return z.NEVER;
    }
  }).optional(),
  search: z.string().trim().max(200).optional(),
  ids: z.string().transform((value) => value.split(",")).pipe(z.array(z.string().min(1).max(200)).min(1).max(100)).optional(),
  personalOnly: z.enum(["true", "false"]).transform((value) => value === "true").optional()
});

const turnEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).safe().default(0)
});

export function buildSessionRouteStores(deps: AppDependencies) {
  return {
    sessions: deps.sessions,
    messages: deps.messages,
    runtimeAdapter: deps.runtimeAdapter,
    limits: deps.limits,
    activeTurns: deps.activeTurns,
    executions: deps.executions,
    turnBus: deps.turnBus,
    auditEvents: deps.auditEvents
  };
}

export type SessionRouteStores = {
  sessions: Pick<AppDependencies["sessions"], "listPage" | "create" | "rename" | "getReadable" | "getOwned" | "remove" | "setArchived" | "restoreDeleted">
    & { getRetentionDays?: () => number };
  messages: Pick<AppDependencies["messages"], "listBySession">;
  runtimeAdapter: Pick<AppDependencies["runtimeAdapter"], "id" | "hasActiveTurn" | "abortSession" | "purgeSessionData" | "interruptTurn">;
  limits: AppDependencies["limits"];
  activeTurns: AppDependencies["activeTurns"];
  auditEvents: Pick<AppDependencies["auditEvents"], "create">;
  executions: Pick<AppDependencies["executions"], "stop"> &
    Partial<Pick<AppDependencies["executions"], "stopAndGetOwner" | "currentOwner">>;
  turnBus?: TurnCoordinationBus;
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
  app.get("/sessions/:sessionId/events", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) return paramsResult.response;
    const queryResult = parseRequestInput(reply, turnEventsQuerySchema, request.query ?? {});
    if (!queryResult.ok) return queryResult.response;

    const { tenantId, userId } = request.auth;
    const { sessionId } = paramsResult.value;
    const session = await stores.sessions.getReadable(tenantId, sessionId, userId);
    if (!session || !canBrowseSessionContent(session)) {
      return reply.code(404).send(notFoundError("session_not_found"));
    }
    const log = stores.activeTurns?.eventLog(sessionId, tenantId);
    if (!log) {
      const owner = await stores.executions?.currentOwner?.(tenantId, sessionId);
      if (!owner || !stores.turnBus) return reply.code(204).send();
      const turn = { tenantId, sessionId, executionId: owner.executionId };
      let replay: SequencedTurnEvent[] | null;
      try { replay = await stores.turnBus.replay(turn, queryResult.value.after); }
      catch (error) {
        request.log.warn({ err: error, sessionId }, "Remote event replay unavailable");
        return reply.code(204).send();
      }
      if (!replay) return reply.code(409).send(apiError("replay_gap"));
      openSseResponse(app, request, reply);
      const writer = new SseWriter(reply.raw);
      const reader = stores.turnBus.reader();
      let after = queryResult.value.after;
      let closed = false;
      writer.onClose(() => { closed = true; reader.disconnect(); });
      try {
        while (!closed) {
          const current = await stores.sessions.getReadable(tenantId, sessionId, userId);
          if (!current || !canBrowseSessionContent(current)) break;
          for (const entry of replay) {
            if (entry.sequence <= after) continue;
            await writer.write(`id: ${entry.sequence}\ndata: ${JSON.stringify(entry.event)}\n\n`);
            after = entry.sequence;
            if (entry.event.type === "RUN_FINISHED" || entry.event.type === "RUN_ERROR") {
              closed = true;
              break;
            }
          }
          if (closed || writer.isClosed) break;
          replay = await stores.turnBus.waitForEvents(reader, turn, after);
          if (!replay) break;
          if (replay.length === 0) {
            const live = await stores.executions.currentOwner?.(tenantId, sessionId);
            if (!live || live.executionId !== owner.executionId) break;
            await writer.write(": keep-alive\n\n");
          }
        }
      } catch (error) {
        if (!closed) request.log.warn({ err: error, sessionId }, "Remote event stream ended");
      } finally {
        reader.disconnect();
        writer.end();
      }
      return;
    }

    const maxPendingBytes = 1_000_000;
    const frameFor = (entry: SequencedTurnEvent) =>
      `id: ${entry.sequence}\ndata: ${JSON.stringify(entry.event)}\n\n`;
    const pending: SequencedTurnEvent[] = [];
    let queuedBytes = 0;
    let closing = false;
    let overflowed = false;
    let finish: (() => void) | undefined;
    let pump: (() => void) | undefined;
    const enqueue = (entry: SequencedTurnEvent) => {
      const frameBytes = Buffer.byteLength(frameFor(entry));
      if (queuedBytes + frameBytes > maxPendingBytes) {
        overflowed = true;
        pending.length = 0;
        queuedBytes = 0;
        subscription?.unsubscribe();
        finish?.();
        return;
      }
      pending.push(entry);
      queuedBytes += frameBytes;
    };
    const subscription = log.subscribe(queryResult.value.after, (entry) => {
      if (overflowed) return;
      if (entry) enqueue(entry);
      else closing = true;
      pump?.();
    });
    if (!subscription) return reply.code(409).send(apiError("replay_gap"));
    for (const entry of subscription.replay) {
      enqueue(entry);
      if (overflowed) return reply.code(409).send(apiError("replay_gap"));
    }

    openSseResponse(app, request, reply);
    const writer = new SseWriter(reply.raw);
    await new Promise<void>((resolve) => {
      let done = false;
      let writing = false;
      let checkingAccess = false;
      finish = () => {
        if (done) return;
        done = true;
        clearInterval(heartbeat);
        subscription.unsubscribe();
        writer.end();
        resolve();
      };
      const heartbeat = setInterval(() => {
        void writer.write(": keep-alive\n\n");
        if (checkingAccess || done) return;
        checkingAccess = true;
        void stores.sessions.getReadable(tenantId, sessionId, userId)
          .then((current) => { if (!current || !canBrowseSessionContent(current)) finish?.(); })
          .catch(() => finish?.())
          .finally(() => { checkingAccess = false; });
      }, 20_000);
      heartbeat.unref?.();
      writer.onClose(finish);
      pump = () => {
        if (writing || done) return;
        writing = true;
        void (async () => {
          try {
            while (pending.length && !writer.isClosed) {
              const entry = pending.shift()!;
              const frame = frameFor(entry);
              queuedBytes -= Buffer.byteLength(frame);
              await writer.write(frame);
            }
          } finally {
            writing = false;
            if (closing || writer.isClosed) finish?.();
            else if (pending.length) pump?.();
          }
        })();
      };
      pump();
    });
  });

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

    const { purposes: _purposes, ...filters } = queryResult.value;
    const page = await stores.sessions.listPage(tenantId, userId, { ...filters, purposes });
    const running = stores.activeTurns?.snapshot();
    const decoratedSessions = page.sessions.map((session) => {
      const isLocalTurn = running?.has(session.sessionId) ?? false;
      const isRunning = isLocalTurn || (stores.executions?.currentOwner
        ? session.isRunning === true
        : session.purpose === "scheduled" && session.isRunning === true);
      const startedAt = isLocalTurn ? stores.activeTurns?.startedAt(session.sessionId) : undefined;
      const turn = isLocalTurn ? stores.activeTurns?.identity(session.sessionId) : undefined;
      return {
        ...session,
        ...(turn ? { latestTurnId: turn.messageId, latestTurnSequence: turn.sequence } : {}),
        hasTurnFailed: !isRunning && session.hasTurnFailed === true,
        isRunning,
        activeTurnStartedAt: startedAt !== undefined
          ? new Date(startedAt).toISOString()
          : isRunning ? session.activeTurnStartedAt : undefined
      };
    });
    return serialize(SessionsListResponseSchema, {
      sessions: decoratedSessions,
      nextCursor: page.nextCursor,
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
      const releaseMutation = stores.activeTurns?.reserveMutation(sessionId);
      if (releaseMutation === null) {
        reply.code(409);
        return apiError("session_busy", "Wait for the current turn to finish before archiving or restoring this session.");
      }
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
        releaseMutation?.();
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
    const setupCancelled = session.canEdit !== false && !stores.executions?.stopAndGetOwner &&
      (stores.activeTurns?.requestCancel(sessionId, tenantId) ?? false);

    if (stores.executions?.stopAndGetOwner) {
      const stopped = await stores.executions.stopAndGetOwner({ tenantId, sessionId, userId });
      const cancelledSetup = !stopped && session.canEdit !== false &&
        (stores.activeTurns?.requestCancelUnadmitted(sessionId, tenantId) ?? false);
      if (!stopped && !cancelledSetup) {
        reply.code(409);
        return apiError("no_active_turn", "There is no active turn you can interrupt in this session.");
      }
      if (stopped && stores.turnBus && stopped.ownerId) {
        await stores.turnBus.publishStop({ tenantId, sessionId, userId,
          executionId: stopped.executionId, ownerId: stopped.ownerId }).catch(error => {
          request.log.warn({ err: error, sessionId }, "Failed to publish turn stop");
        });
      }
      if (stopped && stores.activeTurns?.requestCancelExecution(sessionId, tenantId, stopped.executionId)) {
        try {
          await owningAdapter.interruptTurn({ tenantId, sessionId, userId });
        } catch (error) {
          request.log.warn({ err: error, sessionId }, "Failed to signal the local runtime after fencing");
        }
      }
      if (cancelledSetup) {
        await stores.auditEvents.create({
          tenantId, sessionId, userId, type: "turn.interrupted",
          payload: { adapter: owningAdapter.id }
        }).catch((err) => request.log.warn({ err, sessionId }, "Failed to record turn.interrupted audit event"));
      }
      return { status: "interrupted" };
    }

    if (session.projectId) {
      const stopped = await stores.executions.stop({ tenantId, sessionId, userId });
      if (!stopped && !setupCancelled) return reply.code(409).send(apiError("no_active_turn"));
      await owningAdapter.interruptTurn({ tenantId, sessionId, userId });
      return { status: "interrupted" };
    }

    if (!owningAdapter.interruptTurn) {
      reply.code(501);
      return apiError("interrupt_not_supported", "This runtime does not support interrupting a turn.");
    }

    const result = await owningAdapter.interruptTurn({ tenantId, sessionId, userId });

    if (result === "no_active_turn" && !setupCancelled) {
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
