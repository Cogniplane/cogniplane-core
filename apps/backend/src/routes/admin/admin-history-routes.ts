import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AdminHistoryDetailResponseSchema, AdminHistoryIdSchema, AdminHistoryListQuerySchema, AdminHistoryListResponseSchema } from "@cogniplane/shared-types";
import { serialize } from "../../lib/serialize-response.js";
import { AdminHistoryStore, HistoryInputError } from "../../services/admin-history-store.js";
import { withAdmin } from "./admin-route-helpers.js";

const DetailQuery = z.object({ compareTo: AdminHistoryIdSchema.optional() }).strict();
export async function registerAdminHistoryRoutes(app: FastifyInstance, store: Pick<AdminHistoryStore, "list" | "detail"> = new AdminHistoryStore(app.db)) {
  app.get("/admin/history", withAdmin(app, async (request, reply) => {
    const query = AdminHistoryListQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_history_query", message: "Check the history filter and page size." });
    try {
      return serialize(AdminHistoryListResponseSchema, await store.list(request.auth.tenantId, query.data));
    } catch (error) {
      if (error instanceof HistoryInputError) return reply.code(400).send({ error: "invalid_history_query", message: error.message });
      throw error;
    }
  }));
  app.get("/admin/history/:eventId", withAdmin(app, async (request, reply) => {
    const params = z.object({ eventId: AdminHistoryIdSchema }).safeParse(request.params);
    const query = DetailQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_history_query", message: "Check the history record IDs." });
    try {
      const result = await store.detail(request.auth.tenantId, params.data.eventId, query.data.compareTo);
      if (!result) return reply.code(404).send({ error: "history_record_not_found", message: "This history record is not available." });
      return serialize(AdminHistoryDetailResponseSchema, result);
    } catch (error) {
      if (error instanceof HistoryInputError) return reply.code(400).send({ error: "invalid_history_query", message: error.message });
      throw error;
    }
  }));
}
