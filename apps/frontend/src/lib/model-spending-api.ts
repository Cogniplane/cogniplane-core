import {
  ModelSpendingPolicyUpdateRequestSchema,
  ModelSpendingReconcileRequestSchema,
  ModelSpendingResponseSchema,
  TenantOkResponseSchema,
  type ModelSpendingPolicyUpdateRequest,
  type ModelSpendingResponse
} from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

export type { ModelSpendingPolicy, ModelSpendingReservation, ModelSpendingResponse } from "@cogniplane/shared-types";

/** Without a cursor, the response is the summary for the current UTC month and the first page. */
export async function getModelSpending(cursor?: string | null): Promise<ModelSpendingResponse> {
  const path = cursor ? `/admin/model-spending?${new URLSearchParams({ cursor }).toString()}` : "/admin/model-spending";
  const raw = await request<unknown>(path);
  return parseResponse(ModelSpendingResponseSchema, raw, "GET /admin/model-spending");
}

/** Returns the new summary and first page. A 409 means that another change used this version. */
export async function updateModelSpendingPolicy(input: ModelSpendingPolicyUpdateRequest): Promise<ModelSpendingResponse> {
  const body = ModelSpendingPolicyUpdateRequestSchema.parse(input);
  const raw = await request<unknown>("/admin/model-spending", { method: "PUT", body: JSON.stringify(body) });
  return parseResponse(ModelSpendingResponseSchema, raw, "PUT /admin/model-spending");
}

export async function closeModelSpendingReservation(reservationId: string): Promise<void> {
  const raw = await request<unknown>(`/admin/model-spending/${encodeURIComponent(reservationId)}/close`, { method: "POST" });
  parseResponse(TenantOkResponseSchema, raw, "POST /admin/model-spending/:id/close");
}

export async function reconcileModelSpendingReservation(reservationId: string, actualUsd: number): Promise<void> {
  const body = ModelSpendingReconcileRequestSchema.parse({ actualUsd });
  const raw = await request<unknown>(`/admin/model-spending/${encodeURIComponent(reservationId)}/reconcile`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  parseResponse(TenantOkResponseSchema, raw, "POST /admin/model-spending/:id/reconcile");
}
