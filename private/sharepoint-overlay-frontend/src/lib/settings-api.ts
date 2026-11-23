import { OAuthAuthorizationUrlResponseSchema } from "@cogniplane/shared-types";

import {
  MicrosoftConnectionStatusSchema,
  type MicrosoftConnectionStatus
} from "../../../sharepoint-overlay-contracts/src/index";

import { requestEmpty, requestJson } from "../../../../apps/frontend/src/overlay-sdk/data";

export async function fetchMicrosoftConnectionStatus(): Promise<MicrosoftConnectionStatus> {
  return requestJson("/me/microsoft-connection", MicrosoftConnectionStatusSchema);
}

export async function createMicrosoftAuthorizationUrl(): Promise<string> {
  const result = await requestJson("/me/microsoft-connection/authorize", OAuthAuthorizationUrlResponseSchema, {
    method: "POST"
  });
  return result.url;
}

/** Confirms a suspended connection. `microsoftUserId` is the account that the page shows. */
export async function confirmMicrosoftConnection(microsoftUserId: string): Promise<void> {
  await requestEmpty("/me/microsoft-connection/confirm", {
    method: "POST",
    body: JSON.stringify({ microsoftUserId })
  });
}

export async function deleteMicrosoftConnection(): Promise<void> {
  await requestEmpty("/me/microsoft-connection", {
    method: "DELETE"
  });
}
