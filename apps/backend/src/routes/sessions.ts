import { SessionListCursorSchema } from "../services/session-store.js";
import { canBrowseSessionContent, UNSUPPORTED_TRANSCRIPT_ERROR } from "../services/session-access.js";
import { ProjectAccessError } from "../services/project-access.js";
import { SessionExecutionError } from "../services/session-execution-store.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deriveActionSeverity } from "../services/mcp/policy-gate.js";
import { forwardSignedProxyRpc, proxySigningSecret, proxyUpstreamLimits } from "../services/mcp/proxy-forward.js";
import { PolicyBlockedError } from "../services/policy/policy-service.js";
import { scrubUpstreamCredentialValues } from "../services/mcp/scrub-upstream-credential.js";
import type { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import type { ManagedToolAppResource } from "../services/managed-tools/types.js";
import type { McpAppCspStore } from "../services/mcp/mcp-app-csp-store.js";
import {
  groupCspEntries,
  intersectCspDeclarations,
  parseCspDeclarations,
  type CspDeclarationEntry
} from "@cogniplane/shared-types/csp-sources";

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
import { uuidv7 } from "../lib/uuid.js";
import { hasReplyAfterLastPrompt, historyRunEvents } from "../services/agui-history.js";
import { SseWriter } from "../services/sse-writer.js";
import type { TurnCoordinationBus } from "../services/turn-coordination-bus.js";
import {
  capturedEvents,
  catchUpRemote,
  closeTurnSource,
  openTurnSource,
  streamLocalTurn,
  streamRemoteTurn,
  turnStartedRowId
} from "./session-turn-stream.js";

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

const mcpAppParamsSchema = sessionIdParams.extend({ toolCallId: z.string().min(1).max(200) });

/**
 * The content security policy metadata that a widget gets. The server's own
 * declaration is input, not policy. A widget gets the declared sources that an
 * administrator approved for this server in this tenant, so a server with no
 * approvals gets none. The approved sources go with them, so the sandbox can
 * check the same limit again.
 */
function appResourceCsp(declared: unknown, approved: readonly CspDeclarationEntry[]): Record<string, unknown> | undefined {
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return undefined;
  return { ...intersectCspDeclarations(declared, approved), approvedDomains: groupCspEntries(approved) };
}

export function buildSessionRouteStores(deps: AppDependencies) {
  return {
    sessions: deps.sessions,
    messages: deps.messages,
    dynamicConfig: deps.dynamicConfig,
    tenantMembers: deps.tenantMembers,
    policyService: deps.policyService,
    managedToolCatalog: deps.managedToolCatalog,
    mcpAppCsp: deps.mcpAppCsp,
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
  messages: Pick<AppDependencies["messages"], "listBySession" | "getMcpAppCall">;
  dynamicConfig?: Pick<AppDependencies["dynamicConfig"], "getMcpServerForUser" | "compileRuntimeConfig">;
  tenantMembers?: Pick<AppDependencies["tenantMembers"], "isUserBetaTester">;
  policyService?: Pick<AppDependencies["policyService"], "gateCompletedToolResource">;
  managedToolCatalog?: Pick<ManagedToolCatalog, "get">;
  mcpAppCsp?: Pick<McpAppCspStore, "listApproved" | "recordRequested">;
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
  app.get("/sessions/:sessionId/mcp-apps/:toolCallId", async (request, reply) => {
    const params = parseRequestInput(reply, mcpAppParamsSchema, request.params);
    if (!params.ok) return params.response;
    const { tenantId, userId } = request.auth;
    const { sessionId, toolCallId } = params.value;
    const session = await stores.sessions.getReadable(tenantId, sessionId, userId);
    if (!session || !canBrowseSessionContent(session)) {
      return reply.code(404).send(notFoundError("session_not_found"));
    }
    const call = await stores.messages.getMcpAppCall(tenantId, sessionId, toolCallId);
    if (!call) return reply.code(404).send(notFoundError("mcp_app_not_found"));
    let appInput: Record<string, unknown>;
    try {
      const value: unknown = call.app.input ?? JSON.parse(call.input);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid app input");
      appInput = value as Record<string, unknown>;
    } catch {
      return reply.code(502).send(apiError("mcp_app_input_invalid"));
    }
    if (!stores.dynamicConfig || !stores.tenantMembers || !stores.policyService) {
      return reply.code(404).send(notFoundError("mcp_app_not_found"));
    }
    let managedResource: ManagedToolAppResource | undefined;
    try {
      const isBetaTester = await stores.tenantMembers.isUserBetaTester(tenantId, userId);
      const bundle = await stores.dynamicConfig.compileRuntimeConfig(tenantId, isBetaTester, { sessionId, userId });
      const selectedServer = bundle.mcpServers.find((server) => server.id === call.serverId);
      if (!bundle.runtimePolicy.enabledMcpServers.includes(call.serverId) ||
          !selectedServer || !["proxy", "managed"].includes(selectedServer.mode)) {
        return reply.code(404).send(notFoundError("mcp_app_not_found"));
      }
      const managedTool = selectedServer.mode === "managed" ? stores.managedToolCatalog?.get(call.toolName) : undefined;
      if (selectedServer.mode === "managed") {
        if (!managedTool?.appResource || managedTool.appResource.uri !== call.app.resourceUri ||
            !bundle.runtimePolicy.enabledToolIds.includes(call.toolName)) {
          return reply.code(404).send(notFoundError("mcp_app_not_found"));
        }
        managedResource = managedTool.appResource;
      }
      await stores.policyService.gateCompletedToolResource({
        tenantId,
        sessionId,
        userId,
        runtimeId: null,
        toolName: call.toolName,
        category: managedTool?.category ?? call.serverId,
        severity: deriveActionSeverity(call.toolName, managedTool?.readOnly ?? call.app.readOnly ?? null),
        serverId: call.serverId,
        turnContext: call.app.turnContext ?? null,
        enforcementMode: bundle.runtimePolicy.policyEnforcementMode,
        actionSnapshot: { resourceUri: call.app.resourceUri, toolCallId }
      });
    } catch (error) {
      if (!(error instanceof PolicyBlockedError)) {
        request.log.warn({ err: error, serverId: call.serverId }, "MCP App policy check failed");
      }
      return reply.code(404).send(notFoundError("mcp_app_not_found"));
    }
    if (managedResource) {
      let text: string;
      try {
        text = managedResource.render(appInput);
      } catch {
        return reply.code(502).send(apiError("mcp_app_input_invalid"));
      }
      reply.header("cache-control", "private, no-store");
      return { resource: { uri: managedResource.uri, mimeType: managedResource.mimeType, text },
        input: appInput, result: call.app.result };
    }
    let server: Awaited<ReturnType<typeof stores.dynamicConfig.getMcpServerForUser>>;
    try {
      server = await stores.dynamicConfig.getMcpServerForUser(tenantId, call.serverId, userId);
    } catch {
      return reply.code(404).send(notFoundError("mcp_app_not_found"));
    }
    if (server.mode !== "proxy" || !server.upstreamUrl) {
      return reply.code(404).send(notFoundError("mcp_app_not_found"));
    }
    const response = await forwardSignedProxyRpc({
      server,
      rpc: { jsonrpc: "2.0", id: toolCallId, method: "resources/read", params: { uri: call.app.resourceUri } },
      tenantId,
      userId,
      sessionId,
      runtimeId: `mcp-app-resource:${toolCallId}`,
      signingSecret: proxySigningSecret(app.config),
      limits: proxyUpstreamLimits(app.config, request.log)
    });
    if (response.error || !response.result || typeof response.result !== "object") {
      return reply.code(502).send(apiError("mcp_app_resource_failed"));
    }
    const contents = (response.result as { contents?: unknown }).contents;
    const resource = Array.isArray(contents) ? contents.find((entry) =>
      entry && typeof entry === "object" && entry.uri === call.app.resourceUri &&
      typeof entry.mimeType === "string" && entry.mimeType.toLowerCase().startsWith("text/html") &&
      typeof entry.text === "string"
    ) : undefined;
    if (!resource) return reply.code(502).send(apiError("mcp_app_resource_invalid"));
    const meta = resource._meta && typeof resource._meta === "object" ? resource._meta as Record<string, unknown> : {};
    const ui = meta.ui && typeof meta.ui === "object" ? meta.ui as Record<string, unknown> : {};
    let approved: CspDeclarationEntry[] = [];
    if (stores.mcpAppCsp) {
      // A failed read approves nothing, so the widget loses its outside domains
      // and still opens.
      try {
        approved = await stores.mcpAppCsp.listApproved(tenantId, call.serverId);
      } catch (error) {
        request.log.warn({ err: error, serverId: call.serverId }, "MCP App approved domains could not be read");
      }
      // The record only helps an administrator choose. Losing it changes no policy.
      const requested = parseCspDeclarations(ui.csp);
      if (requested.length > 0) {
        try {
          await stores.mcpAppCsp.recordRequested(tenantId, call.serverId, requested);
        } catch (error) {
          request.log.warn({ err: error, serverId: call.serverId }, "MCP App requested domains could not be recorded");
        }
      }
    }
    const csp = appResourceCsp(ui.csp, approved);
    reply.header("cache-control", "private, no-store");
    return scrubUpstreamCredentialValues({
      resource: {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.text,
        ...(csp ? { _meta: { ui: { csp } } } : {})
      },
      input: appInput,
      result: call.app.result
    }, server.upstreamAuth?.secret);
  });

  // The whole conversation for CopilotKit's connection: the saved history as a
  // finished run, then the turn that runs now, replayed from its start and
  // then live. One connection gives the browser one ordered event stream, so
  // the browser does not merge a separate history read with the replay.
  app.get("/sessions/:sessionId/connect", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) return paramsResult.response;

    const { tenantId, userId } = request.auth;
    const { sessionId } = paramsResult.value;
    const readSession = async () => {
      const session = await stores.sessions.getReadable(tenantId, sessionId, userId);
      return session && canBrowseSessionContent(session) ? session : null;
    };
    const canRead = async () => Boolean(await readSession());
    const session = await readSession();
    if (!session) return reply.code(404).send(notFoundError("session_not_found"));
    // The converter reads only the current history format. An older session
    // stays readable through the message and audit routes.
    if (session.transcriptFormat !== "current") {
      return reply.code(409).send({ ...UNSUPPORTED_TRANSCRIPT_ERROR });
    }

    // Capture the turn before the history read. A local capture holds every
    // event from the start of the turn; a remote replay reads the bus again
    // below. The history read can then miss no event, and an event that the
    // read already reflects is identified by its turn_started row.
    let source = await openTurnSource(stores, { tenantId, sessionId }, request.log);
    let history: Awaited<ReturnType<typeof stores.messages.listBySession>>;
    try {
      history = await stores.messages.listBySession(tenantId, sessionId, userId);
    } catch (error) {
      closeTurnSource(source);
      throw error;
    }
    if (source.kind === "remote" && stores.turnBus) await catchUpRemote(stores.turnBus, source);
    if (source.kind === "local" && source.queue.overflowed) source = { kind: "unavailable" };

    // The replay rebuilds the reply of the running turn under new message
    // ids, so leave its saved row out. turn_started names that row, also when
    // the turn finished during the history read.
    //
    // Without turn_started, the connection cannot name the row. A local
    // capture holds every event up to the end of the read, and the turn adds
    // turn_started to its log before it writes text, tools, or a plan to its
    // row. So that row was still empty, and the converter leaves it out.
    // The owner of a remote turn mirrors its log to the bus later than it
    // writes rows, so the read can already hold the reply. Attach only when no
    // saved row after the newest prompt adds to the history. Otherwise send
    // the history as it is and report the turn as unavailable: the browser
    // polls its end and then loads the final state.
    const replayedRowId = turnStartedRowId(capturedEvents(source));
    if (source.kind === "remote" && !replayedRowId && hasReplyAfterLastPrompt(history.messages)) {
      source = { kind: "unavailable" };
    }
    const attached = source.kind === "local" || source.kind === "remote";
    const messages = attached && replayedRowId
      ? history.messages.filter((message) => message.messageId !== replayedRowId)
      : history.messages;

    openSseResponse(app, request, reply);
    const writer = new SseWriter(reply.raw);
    for (const event of historyRunEvents({
      threadId: sessionId,
      runId: `history:${uuidv7()}`,
      messages,
      connection: {
        activeTurn: attached ? "attached" : source.kind === "none" ? "none" : "unavailable",
        hasMoreHistory: history.hasMore
      }
    })) {
      await writer.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    const options = { writer, canRead, log: request.log, sessionId };
    if (source.kind === "local") await streamLocalTurn(source.queue, options);
    else if (source.kind === "remote" && stores.turnBus) {
      await streamRemoteTurn(source, { turnBus: stores.turnBus, executions: stores.executions }, options);
    } else writer.end();
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
    const queryResult = parseRequestInput(reply,
      z.object({ since: z.string().uuid().optional() }).strict(), request.query);
    if (!queryResult.ok) return queryResult.response;

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
    const { messages, hasMore } = await stores.messages.listBySession(tenantId, sessionId, userId,
      { sinceMessageId: queryResult.value.since });

    reply.header("cache-control", "private, no-store");
    return serialize(SessionMessagesResponseSchema, {
      session,
      messages,
      hasMore
    });
  });
}
