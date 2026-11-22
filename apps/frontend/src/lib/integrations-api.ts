import {
  AdminIntegrationEnvelopeSchema,
  AdminIntegrationsListResponseSchema,
  UserIntegrationsAvailabilityResponseSchema
} from "@cogniplane/shared-types";

import { requestJson } from "./api-client";

import type { AdminIntegrationView, UserIntegrationView } from "@cogniplane/shared-types";

export type UpdateIntegrationInput = {
  readsEnabled?: boolean;
  writesEnabled?: boolean;
  config?: Record<string, string>;
};

export async function fetchAdminIntegrations(): Promise<AdminIntegrationView[]> {
  return (await requestJson("/admin/integrations", AdminIntegrationsListResponseSchema)).integrations;
}

export async function updateIntegration(
  integrationId: string,
  input: UpdateIntegrationInput
): Promise<AdminIntegrationView> {
  return (await requestJson(`/admin/integrations/${integrationId}`, AdminIntegrationEnvelopeSchema, {
    method: "PUT",
    body: JSON.stringify(input)
  })).integration;
}

export async function deleteIntegrationConfig(
  integrationId: string
): Promise<AdminIntegrationView> {
  return (await requestJson(`/admin/integrations/${integrationId}/config`, AdminIntegrationEnvelopeSchema, {
    method: "DELETE"
  })).integration;
}

export async function fetchIntegrationsAvailability(): Promise<UserIntegrationView[]> {
  return (await requestJson("/me/integrations-availability", UserIntegrationsAvailabilityResponseSchema)).enabled;
}
