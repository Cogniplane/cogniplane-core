import type { Artifact, ArtifactPiiDetail } from "@cogniplane/shared-types";

/**
 * PII states that must keep an artifact out of chat context:
 * - `pending` / `scanning`: the scan hasn't cleared the document yet
 * - `blocked`: org policy rejected the document
 *
 * `failed` intentionally stays eligible so a transient provider outage doesn't
 * lock the user out — the UI surfaces the failure via a chip instead.
 */
export function isPiiBlockingContext(pii: ArtifactPiiDetail | undefined): boolean {
  if (!pii?.status) return false;
  return pii.status === "pending" || pii.status === "scanning" || pii.status === "blocked";
}

export function isArtifactEligibleForChatContext(artifact: Artifact): boolean {
  if (artifact.status !== "ready") return false;
  return !isPiiBlockingContext(artifact.detail?.pii);
}
