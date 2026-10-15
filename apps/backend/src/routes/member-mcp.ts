import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  McpCredentialScopeSchema, MemberMcpConnectionsResponseSchema,
  MemberMcpConnectionResponseSchema, MemberMcpCredentialSaveSchema,
  MemberMcpCredentialRemoveSchema, MemberMcpCredentialRemoveResponseSchema
} from "@cogniplane/shared-types";
import type { AppDependencies } from "../app-dependencies.js";
import { apiError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import {
  MemberMcpAccessError, MemberMcpNotFoundError, MemberMcpConflictError, MemberMcpValidationError
} from "../services/member-mcp-credential-store.js";

export type MemberMcpRouteStores = {
  memberMcpCredentials: Pick<AppDependencies["memberMcpCredentials"], "list" | "save" | "remove">;
};
const paramsSchema = z.object({ serverId: z.string().min(1).max(200) });

export async function registerMemberMcpRoutes(app: FastifyInstance, stores: MemberMcpRouteStores) {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof MemberMcpAccessError) return reply.code(403).send(apiError("member_mcp_access", error.message));
      if (error instanceof MemberMcpNotFoundError) return reply.code(404).send(apiError("member_mcp_not_found", error.message));
      if (error instanceof MemberMcpConflictError) return reply.code(409).send(apiError("member_mcp_conflict", error.message));
      if (error instanceof MemberMcpValidationError) return reply.code(400).send(apiError("member_mcp_invalid", error.message));
      throw error;
    });
    routes.addHook("onRequest", async (_request, reply) => { reply.header("cache-control", "private, no-store"); });
    const checkScope = (body: unknown, reply: Parameters<typeof parseRequestInput>[0], tenantId: string, userId: string) => {
      const supplied = typeof body === "object" && body !== null && "scope" in body ? body.scope : undefined;
      const parsed = parseRequestInput(reply, McpCredentialScopeSchema, supplied);
      if (!parsed.ok) return parsed.response;
      if (parsed.value.tenantId !== tenantId || parsed.value.userId !== userId) {
        return reply.code(409).send(apiError("member_mcp_scope_changed", "Your account or organization changed. Reload before connecting."));
      }
      return null;
    };
    routes.get("/me/mcp-connections", async (request) => {
      const { tenantId, userId } = request.auth;
      const connections = await stores.memberMcpCredentials.list(tenantId, userId);
      return serialize(MemberMcpConnectionsResponseSchema, { scope: { tenantId, userId }, connections });
    });
    routes.put("/me/mcp-connections/:serverId/credentials", async (request, reply) => {
      const { tenantId, userId } = request.auth;
      const mismatch = checkScope(request.body, reply, tenantId, userId);
      if (mismatch) return mismatch;
      const params = parseRequestInput(reply, paramsSchema, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, MemberMcpCredentialSaveSchema, request.body);
      if (!body.ok) return body.response;
      const { scope: _scope, ...input } = body.value;
      const connection = await stores.memberMcpCredentials.save(tenantId, userId, params.value.serverId, input);
      return serialize(MemberMcpConnectionResponseSchema, { scope: { tenantId, userId }, connection });
    });
    routes.delete("/me/mcp-connections/:serverId/credentials", async (request, reply) => {
      const { tenantId, userId } = request.auth;
      const mismatch = checkScope(request.body, reply, tenantId, userId);
      if (mismatch) return mismatch;
      const params = parseRequestInput(reply, paramsSchema, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, MemberMcpCredentialRemoveSchema, request.body);
      if (!body.ok) return body.response;
      await stores.memberMcpCredentials.remove(tenantId, userId, params.value.serverId, body.value.version);
      return serialize(MemberMcpCredentialRemoveResponseSchema, { scope: { tenantId, userId }, removed: true });
    });
  });
}
