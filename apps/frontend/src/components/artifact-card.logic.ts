import type { Artifact } from "@cogniplane/shared-types";

import { isPiiHoldingArtifact } from "../lib/artifact-eligibility";
import { canPreviewArtifact } from "../lib/artifact-preview";

/** The artifact of this session with this id, or null. The session check
 *  holds also when a caller gives a stale list or one of several sessions. */
export function findSessionArtifact(
  artifacts: readonly Artifact[],
  sessionId: string,
  artifactId: string
): Artifact | null {
  return artifacts.find((artifact) => artifact.sessionId === sessionId && artifact.artifactId === artifactId) ?? null;
}

/** Why the card cannot open a preview of the artifact, or null when it can.
 *  The artifact must be ready, its PII verdict must let the bytes out (the
 *  backend rule), and the preview must support its type. The server checks
 *  access again when the preview loads. */
export function artifactCardPreviewBlock(artifact: Artifact): string | null {
  if (artifact.status === "pending" || artifact.status === "processing") return "Preview is available when the file is ready.";
  if (artifact.status !== "ready") return "Preview is not available for this file.";
  if (artifact.detail?.pii?.status === "failed") return "The PII scan of this file failed. Preview is not available.";
  if (isPiiHoldingArtifact(artifact.detail?.pii)) return "The PII policy holds this file. Preview is not available.";
  if (!canPreviewArtifact(artifact)) return "Preview is not available for this file type.";
  return null;
}
