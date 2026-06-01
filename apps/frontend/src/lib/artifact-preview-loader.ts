import type { Artifact } from "@cogniplane/shared-types";

import {
  createArtifactDownload,
  fetchArtifactContent,
  fetchArtifactPreviewText
} from "./artifact-api";
import { isImageArtifact, isPdfArtifact } from "./artifact-preview";

export function artifactApiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
}

/**
 * The 3-way preview decision, extracted as a pure async function so it can be
 * unit-tested without a React renderer (the frontend test env is `node`, no
 * jsdom). Returns the resolved preview payload; the calling hook owns the
 * state writes and the request-race guard around this call.
 *
 * - image  → mint a signed download URL, render via <img>  → { kind: "image", imageUrl }
 * - pdf    → server-extracted text                          → { kind: "text", text }
 * - other  → mint a signed URL, fetch the raw text body     → { kind: "text", text }
 *
 * Mirrors the original `useArtifacts.openPreview` branch logic exactly; the
 * deps are injectable so tests don't hit the network.
 */
export type ArtifactPreviewResult =
  | { kind: "image"; imageUrl: string }
  | { kind: "text"; text: string };

export type ArtifactPreviewLoaderDeps = {
  createDownload: typeof createArtifactDownload;
  fetchPreviewText: typeof fetchArtifactPreviewText;
  fetchContent: typeof fetchArtifactContent;
  apiBase: () => string;
};

const defaultDeps: ArtifactPreviewLoaderDeps = {
  createDownload: createArtifactDownload,
  fetchPreviewText: fetchArtifactPreviewText,
  fetchContent: fetchArtifactContent,
  apiBase: artifactApiBase
};

export async function loadArtifactPreview(
  artifact: Pick<Artifact, "artifactId" | "mimeType">,
  deps: ArtifactPreviewLoaderDeps = defaultDeps
): Promise<ArtifactPreviewResult> {
  const { artifactId, mimeType } = artifact;

  if (isImageArtifact(mimeType)) {
    const handle = await deps.createDownload(artifactId);
    return { kind: "image", imageUrl: `${deps.apiBase()}${handle.url}` };
  }

  if (isPdfArtifact(mimeType)) {
    const text = await deps.fetchPreviewText(artifactId);
    return { kind: "text", text };
  }

  const handle = await deps.createDownload(artifactId);
  const text = await deps.fetchContent(`${deps.apiBase()}${handle.url}`);
  return { kind: "text", text };
}
