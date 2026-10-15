import { memberMcpStatuses, type MemberMcpStatusStore } from "./member-mcp-status.js";
import type { FastifyInstance } from "fastify";
import { skillSource } from "../services/capability-selection.js";
import { PersonalCapabilitiesSchema, PersonalCapabilitiesUpdateSchema } from "@cogniplane/shared-types";
import type { AppDependencies } from "../app-dependencies.js";
import { apiError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import { hasUnavailableAdditions } from "../services/capability-selection.js";
import { PersonalCapabilityAccessError } from "../services/personal-capability-store.js";

export type PersonalCapabilityStores = {
  memberMcpCredentials?: MemberMcpStatusStore;
  personalCapabilities: Pick<AppDependencies["personalCapabilities"], "get" | "save">;
  dynamicConfig: Pick<AppDependencies["dynamicConfig"], "compilePersonalCatalog" | "listMcpServers">;
  tenantMembers: Pick<AppDependencies["tenantMembers"], "isUserBetaTester">;
};

export async function registerPersonalCapabilityRoutes(app: FastifyInstance, stores: PersonalCapabilityStores) {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof PersonalCapabilityAccessError) return reply.code(403).send(apiError("membership_required", error.message));
      throw error;
    });
    const catalog = async (tenantId: string, userId: string) => {
      const beta = await stores.tenantMembers.isUserBetaTester(tenantId, userId);
      const [bundle, servers, connectionStatuses] = await Promise.all([
        stores.dynamicConfig.compilePersonalCatalog(tenantId, beta, userId),
        stores.dynamicConfig.listMcpServers(tenantId, false),
        memberMcpStatuses(stores.memberMcpCredentials, tenantId, userId)
      ]);
      return {
        skills: bundle.skills.map(s => ({ id: s.id, name: s.name, description: s.description ?? "",
          source: skillSource(s.sourceType) })),
        connectors: bundle.mcpServers.map(s => ({ id: s.id,
          name: servers.find(server => server.serverId === s.id)?.serverName ?? s.id, description: s.description, ...connectionStatuses.get(s.id) }))
      };
    };
    const conflict = () => apiError("capabilities_conflict", "Your defaults changed. Reload, review your choices, and save again.");

    routes.get("/me/capabilities", async (request, reply) => {
      const { tenantId, userId } = request.auth;
      const saved = await stores.personalCapabilities.get(tenantId, userId);
      const options = await catalog(tenantId, userId);
      reply.header("cache-control", "private, no-store");
      return serialize(PersonalCapabilitiesSchema, { ...saved, ...options, canEdit: true, scope: { tenantId, userId } });
    });

    routes.put("/me/capabilities", async (request, reply) => {
      const body = parseRequestInput(reply, PersonalCapabilitiesUpdateSchema, request.body);
      if (!body.ok) return body.response;
      const { tenantId, userId } = request.auth;
      if (body.value.scope.tenantId !== tenantId || body.value.scope.userId !== userId) {
        return reply.code(409).send(apiError("capabilities_scope_changed", "Your account or organization changed. Reload this page before editing defaults."));
      }
      const current = await stores.personalCapabilities.get(tenantId, userId);
      if (current.version !== body.value.version) return reply.code(409).send(conflict());
      const options = await catalog(tenantId, userId);
      const available = { skillIds: options.skills.map(s => s.id), connectorIds: options.connectors.map(c => c.id) };
      if (hasUnavailableAdditions(body.value.selection, current.selection, available)) {
        return reply.code(400).send(apiError("capability_unavailable", "Some new choices are no longer available. Reload the library and review your additions."));
      }
      const saved = await stores.personalCapabilities.save(tenantId, userId,
        { selection: body.value.selection, version: body.value.version }, available);
      if (!saved) return reply.code(409).send(conflict());
      reply.header("cache-control", "private, no-store");
      return serialize(PersonalCapabilitiesSchema, { ...saved, ...options, canEdit: true, scope: { tenantId, userId } });
    });
  });
}
