import { AdminHistoryDetailResponseSchema, AdminHistoryListResponseSchema, type AdminHistoryEvent, type AdminHistoryListQuery } from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

export type HistoryFilters = Pick<AdminHistoryListQuery, "category" | "type" | "section">;
function normalizeDestination(event: AdminHistoryEvent): AdminHistoryEvent {
  // Older projections derive this target from the policies category.
  if (event.type === "tenant.pii_protection.updated" && event.target?.href === "/admin/policy") {
    return { ...event, target: { label: "Open privacy", href: "/admin/privacy" } };
  }
  return event;
}
export async function listAdminHistory(filters: HistoryFilters & { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) params.set(key, String(value));
  const path = `/admin/history${params.size ? `?${params}` : ""}`;
  const response = parseResponse(AdminHistoryListResponseSchema, await request<unknown>(path, { signal }), "GET /admin/history");
  return { ...response, items: response.items.map(normalizeDestination) };
}
export async function getAdminHistoryEvent(eventId: string, compareTo?: string, signal?: AbortSignal) {
  const path = `/admin/history/${encodeURIComponent(eventId)}${compareTo ? `?${new URLSearchParams({ compareTo })}` : ""}`;
  const response = parseResponse(AdminHistoryDetailResponseSchema, await request<unknown>(path, { signal }), "GET /admin/history/:eventId");
  return { ...response, event: normalizeDestination(response.event) };
}
