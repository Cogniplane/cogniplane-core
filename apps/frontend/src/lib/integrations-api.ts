import {
  AdminIntegrationEnvelopeSchema,
  AdminIntegrationsListResponseSchema,
  UserIntegrationsAvailabilityResponseSchema
} from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type { AdminIntegrationView, UserIntegrationView } from "@cogniplane/shared-types";

export type UpdateIntegrationInput = {
  readsEnabled?: boolean;
  writesEnabled?: boolean;
  config?: Record<string, string>;
};

export async function fetchAdminIntegrations(): Promise<AdminIntegrationView[]> {
  const raw = await request<unknown>("/admin/integrations");
  return parseResponse(AdminIntegrationsListResponseSchema, raw, "GET /admin/integrations")
    .integrations;
}

export async function updateIntegration(
  integrationId: string,
  input: UpdateIntegrationInput
): Promise<AdminIntegrationView> {
  const raw = await request<unknown>(`/admin/integrations/${integrationId}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(AdminIntegrationEnvelopeSchema, raw, "PUT /admin/integrations/:id")
    .integration;
}

export async function deleteIntegrationConfig(
  integrationId: string
): Promise<AdminIntegrationView> {
  const raw = await request<unknown>(`/admin/integrations/${integrationId}/config`, {
    method: "DELETE"
  });
  return parseResponse(AdminIntegrationEnvelopeSchema, raw, "DELETE /admin/integrations/:id/config")
    .integration;
}

export async function fetchIntegrationsAvailability(): Promise<UserIntegrationView[]> {
  const raw = await request<unknown>("/me/integrations-availability");
  return parseResponse(
    UserIntegrationsAvailabilityResponseSchema,
    raw,
    "GET /me/integrations-availability"
  ).enabled;
}
