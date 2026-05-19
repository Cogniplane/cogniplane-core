import type { Artifact, ArtifactPiiDetail } from "@cogniplane/shared-types";
import { isArtifactEligibleForChatContext } from "../lib/artifact-eligibility";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatArtifactStatus(status: Artifact["status"]): string {
  switch (status) {
    case "ready": return "Ready";
    case "processing": return "Processing";
    case "failed": return "Failed";
    case "deleted": return "Deleted";
    default: return "Pending";
  }
}

export function formatPiiLabel(pii: ArtifactPiiDetail): string | null {
  switch (pii.status) {
    case "pending":
    case "scanning":
      return "Scanning for PII…";
    case "blocked":
      return pii.blockReason ? `Blocked: ${pii.blockReason}` : "Blocked by PII policy";
    case "failed":
      return "PII scan failed";
    case "scanned":
      return pii.findingsCount && pii.findingsCount > 0
        ? `PII: ${pii.findingsCount} finding${pii.findingsCount === 1 ? "" : "s"}`
        : "PII: clean";
    case "transformed":
      return "PII redacted";
    default:
      return null;
  }
}

export type PiiTone = "neutral" | "pending" | "blocked" | "failed" | "transformed";

export function piiTone(pii: ArtifactPiiDetail): PiiTone {
  switch (pii.status) {
    case "pending":
    case "scanning":
      return "pending";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "transformed":
      return "transformed";
    default:
      return "neutral";
  }
}

export function canDownloadArtifact(artifact: Artifact): boolean {
  if (artifact.status === "deleted") return false;
  if (artifact.artifactType === "upload") return true;
  return artifact.status === "ready";
}

export function canSelectArtifact(artifact: Artifact): boolean {
  return isArtifactEligibleForChatContext(artifact);
}

export function getArtifactOrigin(artifact: Artifact): string {
  if (artifact.detail?.source === "microsoft") {
    return artifact.createdByType === "tool" ? "Added by assistant" : "Microsoft import";
  }
  if (artifact.createdByType === "tool") return "Added by assistant";
  if (artifact.artifactType === "generated") return "Generated";
  if (artifact.artifactType === "derived") return "Derived";
  return "Uploaded";
}
