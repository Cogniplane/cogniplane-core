import { AdminHistoryDetailResponseSchema, AdminHistoryListResponseSchema, type AdminHistoryListQuery } from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

export type HistoryFilters = Pick<AdminHistoryListQuery, "category" | "type" | "section">;
export async function listAdminHistory(filters: HistoryFilters & { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) params.set(key, String(value));
  const path = `/admin/history${params.size ? `?${params}` : ""}`;
  return parseResponse(AdminHistoryListResponseSchema, await request<unknown>(path, { signal }), "GET /admin/history");
}
export async function getAdminHistoryEvent(eventId: string, compareTo?: string, signal?: AbortSignal) {
  const path = `/admin/history/${encodeURIComponent(eventId)}${compareTo ? `?${new URLSearchParams({ compareTo })}` : ""}`;
  return parseResponse(AdminHistoryDetailResponseSchema, await request<unknown>(path, { signal }), "GET /admin/history/:eventId");
}
