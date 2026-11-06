import type { MicrosoftConnectionStatus } from "../../../sharepoint-overlay-contracts/src/index";

import { request } from "../../../../apps/frontend/src/lib/api-client";

export async function fetchMicrosoftConnectionStatus(): Promise<MicrosoftConnectionStatus> {
  return request<MicrosoftConnectionStatus>("/me/microsoft-connection");
}

export async function createMicrosoftAuthorizationUrl(): Promise<string> {
  const result = await request<{ url: string }>("/me/microsoft-connection/authorize", {
    method: "POST"
  });
  return result.url;
}

/** Confirms a suspended connection. `microsoftUserId` is the account that the page shows. */
export async function confirmMicrosoftConnection(microsoftUserId: string): Promise<void> {
  await request<unknown>("/me/microsoft-connection/confirm", {
    method: "POST",
    body: JSON.stringify({ microsoftUserId })
  });
}

export async function deleteMicrosoftConnection(): Promise<void> {
  await request<void>("/me/microsoft-connection", {
    method: "DELETE"
  });
}
