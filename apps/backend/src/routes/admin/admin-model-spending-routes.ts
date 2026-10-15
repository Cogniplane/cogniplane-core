import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelSpendingStore } from "../../services/model-spending-store.js";
import { apiError } from "../../lib/http-errors.js";
import { withAdmin } from "./admin-route-helpers.js";

const usd = z.number().finite().min(0).max(1_000_000);
const policySchema = z.object({
  monthlyLimitUsd: usd.nullable(),
  turnReservationUsd: usd.min(0.000001),
  version: z.number().int().positive()
}).strict();
const idSchema = z.object({ reservationId: z.string().min(1).max(200) });

export async function registerAdminModelSpendingRoutes(
  app: FastifyInstance, store: Pick<ModelSpendingStore, "get" | "setPolicy" | "close" | "reconcile">
): Promise<void> {
  app.get("/admin/model-spending", withAdmin(app, async (request, reply) => {
    const query = z.object({ cursor: z.string().min(1).max(200).optional() }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send(apiError("invalid_query"));
    return store.get(request.auth.tenantId, query.data.cursor);
  }));
  app.put("/admin/model-spending", withAdmin(app, async (request, reply) => {
    const parsed = policySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError("invalid_config", "Invalid spending policy."));
    await store.setPolicy(request.auth.tenantId, request.auth.userId, parsed.data);
    return store.get(request.auth.tenantId);
  }));
  app.post("/admin/model-spending/:reservationId/close", withAdmin(app, async (request, reply) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send(apiError("invalid_request"));
    await store.close(request.auth.tenantId, request.auth.userId, parsed.data.reservationId);
    return { ok: true };
  }));
  app.post("/admin/model-spending/:reservationId/reconcile", withAdmin(app, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const body = z.object({ actualUsd: usd }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(apiError("invalid_request"));
    await store.reconcile(request.auth.tenantId, request.auth.userId, params.data.reservationId, body.data.actualUsd);
    return { ok: true };
  }));
}
