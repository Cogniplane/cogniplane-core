import {
  ArtifactBrowseResponseSchema,
  ArtifactEnvelopeSchema,
  ArtifactPreviewTextResponseSchema,
  ArtifactsListResponseSchema,
  DownloadHandleEnvelopeSchema
} from "@cogniplane/shared-types";

import { createApiHeaders, request } from "./api-client";
import { parseResponse } from "./validate-response";

import type {
  Artifact,
  ArtifactBrowseResponse,
  ArtifactListQuery,
  DownloadHandle
} from "@cogniplane/shared-types";

export async function listArtifacts(sessionId: string): Promise<Artifact[]> {
  const raw = await request<unknown>(`/sessions/${sessionId}/artifacts`);
  return parseResponse(ArtifactsListResponseSchema, raw, "GET /sessions/:id/artifacts").artifacts;
}

// Query params accepted by the cross-session browser. Cursor is supplied by the
// data hook's pagination, not the caller's filter state.
export type ArtifactBrowseParams = Partial<
  Pick<ArtifactListQuery, "q" | "sort" | "limit">
> & {
  type?: string[];
  status?: string[];
  mimeClass?: string[];
  cursor?: string;
};

function buildArtifactBrowseQuery(params: ArtifactBrowseParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.sort) search.set("sort", params.sort);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  for (const value of params.type ?? []) search.append("type", value);
  for (const value of params.status ?? []) search.append("status", value);
  for (const value of params.mimeClass ?? []) search.append("mimeClass", value);
  return search.toString();
}

export async function browseArtifacts(
  params: ArtifactBrowseParams
): Promise<ArtifactBrowseResponse> {
  const qs = buildArtifactBrowseQuery(params);
  const raw = await request<unknown>(`/artifacts${qs ? `?${qs}` : ""}`);
  return parseResponse(ArtifactBrowseResponseSchema, raw, "GET /artifacts");
}

export async function uploadArtifact(input: {
  sessionId: string;
  file: File;
  name?: string;
}): Promise<Artifact> {
  const form = new FormData();
  form.set("sessionId", input.sessionId);
  form.set("file", input.file);
  if (input.name) {
    form.set("name", input.name);
  }

  const raw = await request<unknown>("/artifacts", {
    method: "POST",
    body: form
  });
  return parseResponse(ArtifactEnvelopeSchema, raw, "POST /artifacts").artifact;
}

export async function createMessageArtifact(messageId: string, name?: string): Promise<Artifact> {
  const raw = await request<unknown>(`/messages/${messageId}/artifact`, {
    method: "POST",
    body: JSON.stringify(name ? { name } : {})
  });
  return parseResponse(ArtifactEnvelopeSchema, raw, "POST /messages/:id/artifact").artifact;
}

export async function createArtifactDownload(artifactId: string): Promise<DownloadHandle> {
  const raw = await request<unknown>(`/artifacts/${artifactId}/download-token`, {
    method: "POST"
  });
  return parseResponse(DownloadHandleEnvelopeSchema, raw, "POST /artifacts/:id/download-token")
    .download;
}

/**
 * Fetch the raw text content of an artifact given its absolute download URL.
 * Caller must obtain a fresh DownloadHandle and prepend NEXT_PUBLIC_API_URL first.
 * Sends auth headers (X-User-Id in dev mode, Bearer token in production).
 * Throws if the response is not ok.
 */
export async function fetchArtifactContent(downloadUrl: string): Promise<string> {
  const response = await fetch(downloadUrl, {
    headers: createApiHeaders(),
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch artifact content: ${response.status}`);
  }
  return response.text();
}

export async function fetchArtifactPreviewText(artifactId: string): Promise<string> {
  const raw = await request<unknown>(`/artifacts/${artifactId}/preview-text`);
  return parseResponse(ArtifactPreviewTextResponseSchema, raw, "GET /artifacts/:id/preview-text")
    .text;
}
