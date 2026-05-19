import { TokenUsageResponseSchema, type TokenUsageSeries } from "@cogniplane/shared-types";

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
