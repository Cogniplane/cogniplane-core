import {
  ModelSpendingPolicyUpdateRequestSchema,
  ModelSpendingReconcileRequestSchema,
  ModelSpendingResponseSchema,
  TenantOkResponseSchema,
  type ModelSpendingPolicyUpdateRequest,
  type ModelSpendingResponse
} from "@cogniplane/shared-types";

import { requestJson } from "./api-client";

export type { ModelSpendingPolicy, ModelSpendingReservation, ModelSpendingResponse } from "@cogniplane/shared-types";

/** Without a cursor, the response is the summary for the current UTC month and the first page. */
export async function getModelSpending(cursor?: string | null): Promise<ModelSpendingResponse> {
  const path = cursor ? `/admin/model-spending?${new URLSearchParams({ cursor }).toString()}` : "/admin/model-spending";
  return await requestJson(path, ModelSpendingResponseSchema);
}

/** Returns the new summary and first page. A 409 means that another change used this version. */
export async function updateModelSpendingPolicy(input: ModelSpendingPolicyUpdateRequest): Promise<ModelSpendingResponse> {
  const body = ModelSpendingPolicyUpdateRequestSchema.parse(input);
  return await requestJson("/admin/model-spending", ModelSpendingResponseSchema, { method: "PUT", body: JSON.stringify(body) });
}

export async function closeModelSpendingReservation(reservationId: string): Promise<void> {
  await requestJson(`/admin/model-spending/${encodeURIComponent(reservationId)}/close`, TenantOkResponseSchema, { method: "POST" });
}

export async function reconcileModelSpendingReservation(reservationId: string, actualUsd: number): Promise<void> {
  const body = ModelSpendingReconcileRequestSchema.parse({ actualUsd });
  await requestJson(`/admin/model-spending/${encodeURIComponent(reservationId)}/reconcile`, TenantOkResponseSchema, {
    method: "POST",
    body: JSON.stringify(body)
  });
}
