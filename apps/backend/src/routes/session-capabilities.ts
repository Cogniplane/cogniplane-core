import { memberMcpStatuses, type MemberMcpStatusStore } from "./member-mcp-status.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SessionCapabilitiesSchema, SessionCapabilitiesUpdateSchema, type SessionCapabilitySelection } from "@cogniplane/shared-types";
import type { AppDependencies } from "../app-dependencies.js";
import { ProjectAccessError } from "../services/project-access.js";
import { SessionExecutionError } from "../services/session-execution-store.js";
import { apiError, notFoundError } from "../lib/http-errors.js";
import { sessionIdParams } from "../lib/route-schemas.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import { hasUnavailableAdditions, skillSource } from "../services/capability-selection.js";

export type SessionCapabilityStores = {
  memberMcpCredentials?: MemberMcpStatusStore;
  sessions: Pick<AppDependencies["sessions"], "getOwned" | "getReadable" | "getCapabilities" | "setCapabilities">;
  dynamicConfig: Pick<AppDependencies["dynamicConfig"], "compileRuntimeConfig" | "compilePersonalCatalog" | "compileProjectCatalog" | "listMcpServers">;
  tenantMembers: Pick<AppDependencies["tenantMembers"], "isUserBetaTester">;
  activeTurns: AppDependencies["activeTurns"];
  runtimeAdapter: Pick<AppDependencies["runtimeAdapter"], "hasActiveTurn">;
};

export async function registerSessionCapabilityRoutes(app: FastifyInstance, stores: SessionCapabilityStores) {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectAccessError) return reply.code(error.status).send(apiError(error.code, error.message));
      if (error instanceof SessionExecutionError) return reply.code(error.statusCode).send(apiError(error.code, error.message));
      throw error;
    });
    await registerScopedSessionCapabilityRoutes(routes, stores);
  });
}

async function registerScopedSessionCapabilityRoutes(app: FastifyInstance, stores: SessionCapabilityStores) {
  const busy = (sessionId: string) => stores.runtimeAdapter.hasActiveTurn(sessionId) || stores.activeTurns.isBusy(sessionId);
  const conflict = (reply: FastifyReply) => {
    reply.code(409);
    return apiError("session_busy", "Finish the current turn and resolve pending approvals before changing capabilities.");
  };
  const readableSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parseRequestInput(reply, sessionIdParams, request.params);
    if (!params.ok) { reply.send(params.response); return null; }
    const { sessionId } = params.value;
    const { tenantId, userId } = request.auth;
    const session = await stores.sessions.getReadable(tenantId, sessionId, userId);
    if (!session || session.status === "deleted") {
      reply.code(404).send(notFoundError("session_not_found"));
      return null;
    }
    return { sessionId, tenantId, userId, session };
  };
  const catalog = async (tenantId: string, userId: string, limit: SessionCapabilitySelection | null,
    context: { personalUserId: string | null; projectId: string | null }) => {
    const beta = await stores.tenantMembers.isUserBetaTester(tenantId, userId);
    // Build the user's available catalog before applying session defaults.
    const [bundle, servers, connectionStatuses] = await Promise.all([
      context.personalUserId
        ? stores.dynamicConfig.compilePersonalCatalog(tenantId, beta, context.personalUserId)
        : context.projectId
          ? stores.dynamicConfig.compileProjectCatalog(tenantId, beta, context.projectId, userId)
          : stores.dynamicConfig.compileRuntimeConfig(tenantId, beta),
      stores.dynamicConfig.listMcpServers(tenantId, false),
      memberMcpStatuses(stores.memberMcpCredentials, tenantId, userId)
    ]);
    return {
      skills: bundle.skills.filter((s) => !limit || limit.skillIds.includes(s.id))
        .map((s) => ({ id: s.id, name: s.name, description: s.description ?? "",
          source: skillSource(s.sourceType) })),
      connectors: bundle.mcpServers.filter((s) => !limit || limit.connectorIds.includes(s.id))
        .map((s) => ({ id: s.id,
        name: servers.find((server) => server.serverId === s.id)?.serverName ?? s.id, description: s.description, ...connectionStatuses.get(s.id) }))
    };
  };

  app.get("/sessions/:sessionId/capabilities", async (request, reply) => {
    const params = parseRequestInput(reply, sessionIdParams, request.params);
    if (!params.ok) return params.response;
    const { sessionId } = params.value;
    const { tenantId, userId } = request.auth;
    if (!await stores.sessions.getReadable(tenantId, sessionId, userId))
      return reply.code(404).send(notFoundError("session_not_found"));
    const saved = await stores.sessions.getCapabilities(tenantId, sessionId, userId);
    const options = await catalog(tenantId, userId, saved.defaultsSelection, saved);
    reply.header("cache-control", "private, no-store");
    return serialize(SessionCapabilitiesSchema, { selection: saved.selection, version: saved.version,
      defaultsSource: saved.defaultsSource, ...options, canEdit: saved.canEdit && !busy(sessionId) });
  });

  app.put("/sessions/:sessionId/capabilities", async (request, reply) => {
    const body = parseRequestInput(reply, SessionCapabilitiesUpdateSchema, request.body);
    if (!body.ok) return body.response;
    const context = await readableSession(request, reply);
    if (!context) return reply;
    const { tenantId, sessionId, userId, session } = context;
    if (session.status !== "active" || busy(sessionId)) return conflict(reply);
    const current = await stores.sessions.getCapabilities(tenantId, sessionId, userId);
    if (current.version !== body.value.version) {
      reply.code(409);
      return apiError("capabilities_conflict", "The session changed or has a pending turn or approval. Reload and try again.");
    }
    const options = await catalog(tenantId, userId, current.defaultsSelection, current);
    const selection = body.value.selection;
    const available = { skillIds: options.skills.map(s => s.id), connectorIds: options.connectors.map(c => c.id) };
    if (hasUnavailableAdditions(selection, current.selection, available)) {
      reply.code(400);
      return apiError("capability_unavailable", "Some capabilities are no longer available. Reload the list and choose again.");
    }
    // Recheck after catalog I/O. Reservation acquisition has no await and its
    // release owns only this mutation, never an entry belonging to a turn.
    if (stores.runtimeAdapter.hasActiveTurn(sessionId)) return conflict(reply);
    const release = stores.activeTurns.reserveMutation(sessionId);
    if (!release) return conflict(reply);
    try {
      if (!await stores.sessions.setCapabilities(tenantId, sessionId, userId, body.value, available)) {
        reply.code(409);
        return apiError("capabilities_conflict", "The session changed or has a pending turn or approval. Reload and try again.");
      }
    } finally { release(); }
    const saved = await stores.sessions.getCapabilities(tenantId, sessionId, userId);
    return serialize(SessionCapabilitiesSchema, { selection: saved.selection, version: saved.version,
      defaultsSource: saved.defaultsSource, ...options, canEdit: saved.canEdit && !busy(sessionId) });
  });
}
