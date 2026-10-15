import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { withTenantScope } from "../../lib/db.js";
import { apiError } from "../../lib/http-errors.js";
import { adminIdSchema, withAdmin } from "./admin-route-helpers.js";

const querySchema = z.object({
  days: z
    .string()
    .optional()
    .transform((v) => {
      const n = parseInt(v ?? "30", 10);
      return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
    }),
  groupBy: z.enum(["day", "user", "model"]).optional().default("day"),
  // Optional filters for one person's page. Without them the response is the
  // tenant-wide rolling window, unchanged for existing callers.
  userId: adminIdSchema.optional(),
  period: z.literal("current_month").optional()
});

/** The UTC calendar month that contains `now`, as a half-open range [from, to). */
export function currentUtcMonth(now: Date): { from: Date; to: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 1))
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

export async function registerAdminTokenUsageRoutes(
  app: FastifyInstance,
  options: { now?: () => Date } = {}
): Promise<void> {
  const now = options.now ?? (() => new Date());

  app.get(
    "/admin/token-usage",
    withAdmin(app, async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400);
        return apiError("invalid_query", "The token-usage query parameters are invalid.");
      }

      const { userId, period } = parsed.data;
      const { tenantId } = request.auth;
      const range = period === "current_month" ? currentUtcMonth(now()) : null;
      const days = range ? Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS) : parsed.data.days;

      // Every aggregation below shares this filter, so a user or month filter
      // scopes the daily series, the breakdowns, and the totals together.
      const values: unknown[] = [tenantId];
      const conditions = ["tenant_id = $1", "role = 'assistant'", "total_tokens IS NOT NULL"];
      if (range) {
        values.push(range.from.toISOString(), range.to.toISOString());
        conditions.push("created_at >= $2::timestamptz", "created_at < $3::timestamptz");
      } else {
        values.push(days);
        conditions.push("created_at >= NOW() - ($2 || ' days')::interval");
      }
      if (userId) {
        values.push(userId);
        conditions.push(`user_id = $${values.length}`);
      }
      const where = conditions.join("\n                AND ");

      const usage = await withTenantScope(app.db, tenantId, async (client) => {
        const [dailyResult, userResult, modelResult, totalsResult] = await Promise.all([
          // Daily aggregation
          client.query(
            `
              SELECT
                -- As text: node-postgres would turn a DATE into a Date at local
                -- midnight, which is the previous UTC day east of UTC.
                DATE(created_at AT TIME ZONE 'UTC')::text AS date,
                COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(total_tokens), 0)::bigint  AS total_tokens,
                COALESCE(SUM(cost_usd), 0)::float       AS cost_usd
              FROM messages
              WHERE
                ${where}
              GROUP BY DATE(created_at AT TIME ZONE 'UTC')
              ORDER BY date ASC
            `,
            values
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
                ${where}
              GROUP BY user_id
              ORDER BY total_tokens DESC
              LIMIT 50
            `,
            values
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
                ${where}
              GROUP BY COALESCE(model_name, 'unknown')
              ORDER BY total_tokens DESC
            `,
            values
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
                ${where}
            `,
            values
          )
        ]);

        const daily: TokenUsageDayPoint[] = dailyResult.rows.map((row) => ({
          date: String(row.date),
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

      return {
        usage,
        days,
        ...(range
          ? { period: "current_month" as const, range: { from: range.from.toISOString(), to: range.to.toISOString() } }
          : {}),
        ...(userId ? { userId } : {})
      };
    })
  );
}
