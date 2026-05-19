import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDependencies } from "../app-dependencies.js";
import { notFoundError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { messageIdParams } from "../lib/route-schemas.js";
import { withTenantScope } from "../lib/db.js";
import { withAdmin } from "./admin/admin-route-helpers.js";

const feedbackBodySchema = z.object({
  rating: z.enum(["thumbs_up", "thumbs_down"]),
  notes: z.string().max(2000).optional()
});

const adminFeedbackQuerySchema = z.object({
  days: z
    .string()
    .optional()
    .transform((v) => {
      const n = parseInt(v ?? "30", 10);
      return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
    })
});

export type FeedbackSummary = {
  thumbsUp: number;
  thumbsDown: number;
  total: number;
  ratePercent: number | null;
};

export type FeedbackDayPoint = {
  date: string;
  thumbsUp: number;
  thumbsDown: number;
};

export type MessageFeedbackStats = {
  totals: FeedbackSummary;
  daily: FeedbackDayPoint[];
  byModel: Array<{ modelName: string } & FeedbackSummary>;
};

export function buildMessageFeedbackRouteStores(deps: AppDependencies) {
  return {
    messages: deps.messages
  };
}

export type MessageFeedbackRouteStores = ReturnType<typeof buildMessageFeedbackRouteStores>;

export async function registerMessageFeedbackRoutes(
  app: FastifyInstance,
  stores: MessageFeedbackRouteStores
): Promise<void> {
  // PATCH /messages/:messageId/feedback — user submits feedback on an assistant message
  app.patch("/messages/:messageId/feedback", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, messageIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseRequestInput(reply, feedbackBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { userId, tenantId } = request.auth;
    const { messageId } = paramsResult.value;
    const { rating, notes = null } = bodyResult.value;

    const updated = await stores.messages.updateFeedback(tenantId, messageId, userId, rating, notes);
    if (!updated) {
      reply.code(404);
      return notFoundError("message_not_found");
    }

    reply.code(204);
    return null;
  });

  // GET /admin/message-feedback — admin analytics
  app.get(
    "/admin/message-feedback",
    withAdmin(app, async (request, reply) => {
      const parsed = adminFeedbackQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_query" };
      }

      const { days } = parsed.data;
      const { tenantId } = request.auth;

      const stats = await withTenantScope(app.db, tenantId, async (client) => {
        const [totalsResult, dailyResult, modelResult] = await Promise.all([
          client.query(
            `
              SELECT
                COUNT(*) FILTER (WHERE feedback_rating = 'thumbs_up')::int   AS thumbs_up,
                COUNT(*) FILTER (WHERE feedback_rating = 'thumbs_down')::int AS thumbs_down,
                COUNT(*)::int                                                  AS total
              FROM messages
              WHERE
                tenant_id = $1
                AND role = 'assistant'
                AND feedback_rating IS NOT NULL
                AND feedback_given_at >= NOW() - ($2 || ' days')::interval
            `,
            [tenantId, days]
          ),

          client.query(
            `
              SELECT
                DATE(feedback_given_at AT TIME ZONE 'UTC') AS date,
                COUNT(*) FILTER (WHERE feedback_rating = 'thumbs_up')::int   AS thumbs_up,
                COUNT(*) FILTER (WHERE feedback_rating = 'thumbs_down')::int AS thumbs_down
              FROM messages
              WHERE
                tenant_id = $1
                AND role = 'assistant'
                AND feedback_rating IS NOT NULL
                AND feedback_given_at >= NOW() - ($2 || ' days')::interval
              GROUP BY DATE(feedback_given_at AT TIME ZONE 'UTC')
              ORDER BY date ASC
            `,
            [tenantId, days]
          ),

          client.query(
            `
              SELECT
                COALESCE(model_name, 'unknown') AS model_name,
                COUNT(*) FILTER (WHERE feedback_rating = 'thumbs_up')::int   AS thumbs_up,
                COUNT(*) FILTER (WHERE feedback_rating = 'thumbs_down')::int AS thumbs_down,
                COUNT(*)::int                                                  AS total
              FROM messages
              WHERE
                tenant_id = $1
                AND role = 'assistant'
                AND feedback_rating IS NOT NULL
                AND feedback_given_at >= NOW() - ($2 || ' days')::interval
              GROUP BY COALESCE(model_name, 'unknown')
              ORDER BY total DESC
            `,
            [tenantId, days]
          )
        ]);

        const totalsRow = totalsResult.rows[0];
        const thumbsUp = Number(totalsRow?.thumbs_up ?? 0);
        const thumbsDown = Number(totalsRow?.thumbs_down ?? 0);
        const total = Number(totalsRow?.total ?? 0);

        const totals: FeedbackSummary = {
          thumbsUp,
          thumbsDown,
          total,
          ratePercent: total > 0 ? Math.round((thumbsUp / total) * 100) : null
        };

        const daily: FeedbackDayPoint[] = dailyResult.rows.map((row) => ({
          date: String(row.date).slice(0, 10),
          thumbsUp: Number(row.thumbs_up),
          thumbsDown: Number(row.thumbs_down)
        }));

        const byModel = modelResult.rows.map((row) => {
          const up = Number(row.thumbs_up);
          const down = Number(row.thumbs_down);
          const t = Number(row.total);
          return {
            modelName: String(row.model_name),
            thumbsUp: up,
            thumbsDown: down,
            total: t,
            ratePercent: t > 0 ? Math.round((up / t) * 100) : null
          };
        });

        return { totals, daily, byModel } satisfies MessageFeedbackStats;
      });

      return { stats, days };
    })
  );
}
