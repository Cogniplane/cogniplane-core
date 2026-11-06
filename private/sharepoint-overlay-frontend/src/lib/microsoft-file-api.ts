import { request } from "../../../../apps/frontend/src/lib/api-client";

import type { Artifact } from "@cogniplane/shared-types";
import type {
  MicrosoftConnectionStatus,
  MicrosoftFile,
  MicrosoftSite
} from "../../../sharepoint-overlay-contracts/src/index";

export async function getMicrosoftConnectionStatus(): Promise<MicrosoftConnectionStatus> {
  return request<MicrosoftConnectionStatus>("/me/microsoft-connection");
}

export async function listMicrosoftSites(search?: string): Promise<MicrosoftSite[]> {
  const params = new URLSearchParams();
  if (search?.trim()) {
    params.set("search", search.trim());
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await request<{ sites: MicrosoftSite[] }>(`/integrations/microsoft/sites${suffix}`);
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
  const result = await request<{ items: MicrosoftFile[] }>(`/integrations/microsoft/files${suffix}`);
  return result.items;
}

export async function searchMicrosoftFiles(query: string, maxResults = 10): Promise<MicrosoftFile[]> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults)
  });

  const result = await request<{ results: MicrosoftFile[] }>(
    `/integrations/microsoft/files/search?${params.toString()}`
  );
  return result.results;
}

export async function importMicrosoftFileToSession(input: {
  sessionId: string;
  driveId: string;
  itemId: string;
  artifactName?: string;
}): Promise<Artifact> {
  const result = await request<{ artifact: Artifact }>(
    `/sessions/${input.sessionId}/import-microsoft-file`,
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
