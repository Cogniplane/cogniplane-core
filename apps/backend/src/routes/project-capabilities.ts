import { memberMcpStatuses, type MemberMcpStatusStore } from "./member-mcp-status.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProjectCapabilitiesSchema, ProjectCapabilitiesUpdateSchema } from "@cogniplane/shared-types";
import type { AppDependencies } from "../app-dependencies.js";
import { apiError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import { ProjectAccessError } from "../services/project-access.js";
import { hasUnavailableAdditions, skillSource } from "../services/capability-selection.js";

export type ProjectCapabilityStores = {
  memberMcpCredentials?: MemberMcpStatusStore;
  projects: Pick<AppDependencies["projects"], "getReadable" | "getCapabilities" | "setCapabilities">;
  dynamicConfig: Pick<AppDependencies["dynamicConfig"], "compileProjectCatalog" | "listMcpServers">;
  tenantMembers: Pick<AppDependencies["tenantMembers"], "isUserBetaTester">;
};

const paramsSchema = z.object({ projectId: z.string().uuid() });

export async function registerProjectCapabilityRoutes(app: FastifyInstance, stores: ProjectCapabilityStores) {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectAccessError) return reply.code(error.status).send(apiError(error.code, error.message));
      throw error;
    });

    // Callers check project read access first. Only this project's skills join the catalog.
    const catalog = async (tenantId: string, userId: string, projectId: string) => {
      const beta = await stores.tenantMembers.isUserBetaTester(tenantId, userId);
      const [bundle, servers, connectionStatuses] = await Promise.all([
        stores.dynamicConfig.compileProjectCatalog(tenantId, beta, projectId, userId),
        stores.dynamicConfig.listMcpServers(tenantId, false),
        memberMcpStatuses(stores.memberMcpCredentials, tenantId, userId)
      ]);
      return {
        skills: bundle.skills.map(s => ({ id: s.id, name: s.name, description: s.description ?? "",
          source: skillSource(s.sourceType) })),
        connectors: bundle.mcpServers.map(s => ({
          id: s.id,
          name: servers.find(server => server.serverId === s.id)?.serverName ?? s.id,
          description: s.description, ...connectionStatuses.get(s.id)
        }))
      };
    };

    routes.get("/projects/:projectId/capabilities", async (request, reply) => {
      const params = parseRequestInput(reply, paramsSchema, request.params);
      if (!params.ok) return params.response;
      const { tenantId, userId } = request.auth;
      const saved = await stores.projects.getCapabilities(tenantId, userId, params.value.projectId);
      const options = await catalog(tenantId, userId, params.value.projectId);
      reply.header("cache-control", "private, no-store");
      return serialize(ProjectCapabilitiesSchema, { ...saved, ...options });
    });

    routes.put("/projects/:projectId/capabilities", async (request, reply) => {
      const params = parseRequestInput(reply, paramsSchema, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, ProjectCapabilitiesUpdateSchema, request.body);
      if (!body.ok) return body.response;
      const { tenantId, userId } = request.auth;
      const { projectId } = params.value;
      const project = await stores.projects.getReadable(tenantId, userId, projectId);
      if (!project) return reply.code(404).send(apiError("project_not_found", "This project is unavailable."));
      if (!project.canManage) return reply.code(403).send(apiError("project_role_required", "Your project role does not allow this action."));
      if (project.archivedAt) return reply.code(409).send(apiError("project_archived", "Restore the project before changing it."));
      const current = await stores.projects.getCapabilities(tenantId, userId, projectId);
      if (current.version !== body.value.version) {
        return reply.code(409).send(apiError("capabilities_conflict", "The project changed or has an active turn or approval. Reload and try again."));
      }
      const options = await catalog(tenantId, userId, projectId);
      const selection = body.value.selection;
      const available = { skillIds: options.skills.map(s => s.id), connectorIds: options.connectors.map(c => c.id) };
      if (hasUnavailableAdditions(selection, current.selection, available)) {
        return reply.code(400).send(apiError("capability_unavailable", "Some capabilities are no longer available. Reload the list and choose again."));
      }
      if (!await stores.projects.setCapabilities(tenantId, userId, projectId, body.value, available)) {
        return reply.code(409).send(apiError("capabilities_conflict", "The project changed or has an active turn or approval. Reload and try again."));
      }
      const saved = await stores.projects.getCapabilities(tenantId, userId, projectId);
      reply.header("cache-control", "private, no-store");
      return serialize(ProjectCapabilitiesSchema, { ...saved, ...options });
    });
  });
}
