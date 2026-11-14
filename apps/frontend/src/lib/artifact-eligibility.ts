import {
  isArtifactPiiEligible,
  isArtifactPiiVerdictEligible,
  type Artifact,
  type ArtifactPiiDetail
} from "@cogniplane/shared-types";

/**
 * True when the PII verdict keeps the file's bytes in the store. The rule is
 * the backend's (`@cogniplane/shared-types`): only no verdict, `scanned` or
 * `transformed` lets them out. A pending scan, a block, a failed scan and an
 * unknown value hold the file. The backend refuses chat context, preview and
 * download for it, so the UI does not offer them.
 */
export function isPiiHoldingArtifact(pii: ArtifactPiiDetail | undefined): boolean {
  return !isArtifactPiiVerdictEligible(pii?.status);
}

/** The artifact can go into a message request, a preview or a download. */
export function isArtifactEligibleForChatContext(artifact: Artifact): boolean {
  return isArtifactPiiEligible(artifact);
}
