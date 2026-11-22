import { requestJson } from "../../../../apps/frontend/src/lib/api-client";

import { ArtifactEnvelopeSchema, type Artifact } from "@cogniplane/shared-types";
import {
  MicrosoftConnectionStatusSchema,
  MicrosoftFilesListResponseSchema,
  MicrosoftFilesSearchResponseSchema,
  MicrosoftSitesListResponseSchema,
  type MicrosoftConnectionStatus,
  type MicrosoftFile,
  type MicrosoftSite
} from "../../../sharepoint-overlay-contracts/src/index";

export async function getMicrosoftConnectionStatus(): Promise<MicrosoftConnectionStatus> {
  return requestJson("/me/microsoft-connection", MicrosoftConnectionStatusSchema);
}

export async function listMicrosoftSites(search?: string): Promise<MicrosoftSite[]> {
  const params = new URLSearchParams();
  if (search?.trim()) {
    params.set("search", search.trim());
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await requestJson(`/integrations/microsoft/sites${suffix}`, MicrosoftSitesListResponseSchema);
  return result.sites;
}

export async function listMicrosoftFiles(input?: {
  siteId?: string | null;
  driveId?: string | null;
  folderId?: string | null;
}): Promise<MicrosoftFile[]> {
  const params = new URLSearchParams();
  if (input?.siteId) params.set("siteId", input.siteId);
  if (input?.driveId) params.set("driveId", input.driveId);
  if (input?.folderId) params.set("folderId", input.folderId);

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await requestJson(`/integrations/microsoft/files${suffix}`, MicrosoftFilesListResponseSchema);
  return result.items;
}

export async function searchMicrosoftFiles(query: string, maxResults = 10): Promise<MicrosoftFile[]> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults)
  });

  const result = await requestJson(
    `/integrations/microsoft/files/search?${params.toString()}`,
    MicrosoftFilesSearchResponseSchema
  );
  return result.results;
}

export async function importMicrosoftFileToSession(input: {
  sessionId: string;
  driveId: string;
  itemId: string;
  artifactName?: string;
}): Promise<Artifact> {
  const result = await requestJson(
    `/sessions/${input.sessionId}/import-microsoft-file`,
    ArtifactEnvelopeSchema,
    {
      method: "POST",
      body: JSON.stringify({
        driveId: input.driveId,
        itemId: input.itemId,
        artifactName: input.artifactName
      })
    }
  );

  return result.artifact;
}
