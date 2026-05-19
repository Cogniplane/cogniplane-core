import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { withTenantScope } from "../../lib/db.js";
import { withAdmin } from "./admin-route-helpers.js";

function toIsoDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

const querySchema = z.object({
  days: z
    .string()
    .optional()
    .transform((v) => {
      const n = parseInt(v ?? "30", 10);
      return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
    }),
  groupBy: z.enum(["day", "user", "model"]).optional().default("day")
});

export type TokenUsageDayPoint = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type TokenUsageUserBreakdown = {
  userId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type TokenUsageModelBreakdown = {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type TokenUsageSeries = {
  daily: TokenUsageDayPoint[];
  byUser: TokenUsageUserBreakdown[];
  byModel: TokenUsageModelBreakdown[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    messageCount: number;
  };
};

export async function registerAdminTokenUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/token-usage",
    withAdmin(app, async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_query" };
      }

      const { days } = parsed.data;
      const { tenantId } = request.auth;

      const usage = await withTenantScope(app.db, tenantId, async (client) => {
        const [dailyResult, userResult, modelResult, totalsResult] = await Promise.all([
          // Daily aggregation
          client.query(
            `
              SELECT
                DATE(created_at AT TIME ZONE 'UTC') AS date,
                COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(total_tokens), 0)::bigint  AS total_tokens,
                COALESCE(SUM(cost_usd), 0)::float       AS cost_usd
              FROM messages
              WHERE
                tenant_id = $1
                AND role = 'assistant'
                AND total_tokens IS NOT NULL
                AND created_at >= NOW() - ($2 || ' days')::interval
              GROUP BY DATE(created_at AT TIME ZONE 'UTC')
              ORDER BY date ASC
            `,
            [tenantId, days]
          ),

          // Per-user aggregation
          client.query(
            `
              SELECT
                user_id,
                COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(total_tokens), 0)::bigint  AS total_tokens,
                COALESCE(SUM(cost_usd), 0)::float       AS cost_usd
              FROM messages
              WHERE
                tenant_id = $1
                AND role = 'assistant'
                AND total_tokens IS NOT NULL
                AND created_at >= NOW() - ($2 || ' days')::interval
              GROUP BY user_id
              ORDER BY total_tokens DESC
              LIMIT 50
            `,
            [tenantId, days]
          ),

          // Per-model aggregation
          client.query(
            `
              SELECT
                COALESCE(model_name, 'unknown') AS model_name,
                COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(total_tokens), 0)::bigint  AS total_tokens,
                COALESCE(SUM(cost_usd), 0)::float       AS cost_usd
              FROM messages
              WHERE
                tenant_id = $1
                AND role = 'assistant'
                AND total_tokens IS NOT NULL
                AND created_at >= NOW() - ($2 || ' days')::interval
              GROUP BY COALESCE(model_name, 'unknown')
              ORDER BY total_tokens DESC
            `,
            [tenantId, days]
          ),

          // Overall totals
          client.query(
            `
              SELECT
                COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(total_tokens), 0)::bigint  AS total_tokens,
                COALESCE(SUM(cost_usd), 0)::float       AS cost_usd,
                COUNT(*)::bigint                         AS message_count
              FROM messages
              WHERE
                tenant_id = $1
                AND role = 'assistant'
                AND total_tokens IS NOT NULL
                AND created_at >= NOW() - ($2 || ' days')::interval
            `,
            [tenantId, days]
          )
        ]);

        const daily: TokenUsageDayPoint[] = dailyResult.rows.map((row) => ({
          date: toIsoDate(row.date),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          totalTokens: Number(row.total_tokens),
          costUsd: Number(row.cost_usd)
        }));

        const byUser: TokenUsageUserBreakdown[] = userResult.rows.map((row) => ({
          userId: String(row.user_id),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          totalTokens: Number(row.total_tokens),
          costUsd: Number(row.cost_usd)
        }));

        const byModel: TokenUsageModelBreakdown[] = modelResult.rows.map((row) => ({
          modelName: String(row.model_name),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          totalTokens: Number(row.total_tokens),
          costUsd: Number(row.cost_usd)
        }));

        const totalsRow = totalsResult.rows[0];
        const totals = {
          inputTokens: Number(totalsRow?.input_tokens ?? 0),
          outputTokens: Number(totalsRow?.output_tokens ?? 0),
          totalTokens: Number(totalsRow?.total_tokens ?? 0),
          costUsd: Number(totalsRow?.cost_usd ?? 0),
          messageCount: Number(totalsRow?.message_count ?? 0)
        };

        return { daily, byUser, byModel, totals };
      });

      return { usage, days };
    })
  );
}
