import {
  ArtifactBrowseResponseSchema,
  ArtifactEnvelopeSchema,
  ArtifactPreviewTextResponseSchema,
  ArtifactsListResponseSchema,
  DownloadHandleEnvelopeSchema
} from "@cogniplane/shared-types";

import { createApiHeaders, requestJson } from "./api-client";
import { ArtifactPreviewTooLargeError } from "./artifact-preview";

import type {
  Artifact,
  ArtifactBrowseResponse,
  ArtifactListQuery,
  DownloadHandle
} from "@cogniplane/shared-types";

export async function listArtifacts(sessionId: string, signal?: AbortSignal): Promise<Artifact[]> {
  return (await requestJson(`/sessions/${sessionId}/artifacts`, ArtifactsListResponseSchema, { signal })).artifacts;
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
  return await requestJson(`/artifacts${qs ? `?${qs}` : ""}`, ArtifactBrowseResponseSchema);
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

  return (await requestJson("/artifacts", ArtifactEnvelopeSchema, {
    method: "POST",
    body: form
  })).artifact;
}

export async function createArtifactDownload(artifactId: string): Promise<DownloadHandle> {
  return (await requestJson(`/artifacts/${artifactId}/download-token`, DownloadHandleEnvelopeSchema, {
    method: "POST"
  })).download;
}

/**
 * Fetch the raw text content of an artifact given its absolute download URL.
 * Caller must obtain a fresh DownloadHandle and prepend NEXT_PUBLIC_API_URL first.
 * Sends auth headers (X-User-Id in dev mode, Bearer token in production).
 * Reads at most `maxBytes` of the body. When Content-Length or the bytes read
 * go over that limit, it cancels the download and throws
 * ArtifactPreviewTooLargeError. Throws if the response is not ok.
 */
export async function fetchArtifactContent(downloadUrl: string, maxBytes: number): Promise<string> {
  const response = await fetch(downloadUrl, {
    headers: createApiHeaders(),
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch artifact content: ${response.status}`);
  }
  return readTextWithinLimit(response, maxBytes);
}

async function readTextWithinLimit(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new ArtifactPreviewTooLargeError();
  }
  if (!response.body) return "";

  // Content-Length can be missing, wrong, or the compressed size, so the loop
  // counts the bytes that it reads.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    bytesRead += chunk.value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new ArtifactPreviewTooLargeError();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

export async function fetchArtifactPreviewText(artifactId: string): Promise<string> {
  return (await requestJson(`/artifacts/${artifactId}/preview-text`, ArtifactPreviewTextResponseSchema)).text;
}
