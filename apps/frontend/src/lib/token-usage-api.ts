import {
  TokenUsageResponseSchema,
  type TokenUsageResponse,
  type TokenUsageSeries
} from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

export type {
  TokenUsageDayPoint,
  TokenUsageModelBreakdown,
  TokenUsageSeries,
  TokenUsageUserBreakdown
} from "@cogniplane/shared-types";

export async function fetchTokenUsage(days: number): Promise<TokenUsageSeries> {
  const raw = await request<unknown>(`/admin/token-usage?days=${days}`);
  return parseResponse(TokenUsageResponseSchema, raw, "GET /admin/token-usage").usage;
}

export type MemberMonthUsage = {
  usage: TokenUsageSeries;
  range: NonNullable<TokenUsageResponse["range"]>;
};

/**
 * One member's usage for the current UTC calendar month. The response must
 * echo the requested member and period. A server that ignored the filters
 * would return tenant-wide numbers, so that response is an error, not data.
 */
export async function fetchMemberMonthUsage(userId: string): Promise<MemberMonthUsage> {
  const search = new URLSearchParams({ userId, period: "current_month" });
  const raw = await request<unknown>(`/admin/token-usage?${search.toString()}`);
  const response = parseResponse(TokenUsageResponseSchema, raw, "GET /admin/token-usage");
  if (response.userId !== userId || response.period !== "current_month" || !response.range) {
    throw new Error("This server cannot report usage for one person yet.");
  }
  return { usage: response.usage, range: response.range };
}
