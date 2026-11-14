import type { Artifact, ArtifactPiiDetail } from "@cogniplane/shared-types";
import { isArtifactEligibleForChatContext } from "../lib/artifact-eligibility";
import { findArtifactOrigin, type ArtifactOriginTone } from "../lib/artifact-origins";

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
  const label = formatPiiVerdict(pii);
  // A verdict on a PDF says when it did not cover all page images.
  const coverage = label && !isPiiNotScanned(pii) && (pii.status === "scanned" || pii.status === "transformed")
    ? imageCoverageSuffix(pii)
    : null;
  return coverage ? `${label} (${coverage})` : label;
}

// Only OCR that read every page covers the images. `imagesNotScanned`
// without `imageScan` is a text-only scan: OCR was off.
function imageCoverageSuffix(pii: ArtifactPiiDetail): string | null {
  if (pii.imageScan === "partial") return "images partly scanned";
  if (pii.imageScan === "failed") return "image scan failed";
  if (pii.imageScan === "complete") return null;
  return pii.imagesNotScanned ? "text only" : null;
}

// The scan applied mode off: protection was off, or the file was out of
// scope, when the scan ran. It read nothing, so the file is not clean.
function isPiiNotScanned(pii: ArtifactPiiDetail): boolean {
  return pii.status === "scanned" && pii.modeApplied === "off";
}

function formatPiiVerdict(pii: ArtifactPiiDetail): string | null {
  switch (pii.status) {
    case "pending":
    case "scanning":
      return "Scanning for PII…";
    case "blocked":
      return pii.blockReason ? `Blocked: ${pii.blockReason}` : "Blocked by PII policy";
    case "failed":
      return "PII scan failed";
    case "scanned":
      if (isPiiNotScanned(pii)) return "PII: not scanned";
      return pii.findingsCount && pii.findingsCount > 0
        ? `PII: ${pii.findingsCount} finding${pii.findingsCount === 1 ? "" : "s"}`
        : "PII: clean";
    case "transformed":
      return "PII redacted";
    default:
      return null;
  }
}

// `clean` and `findings` are the two outcomes of a real scan. A scan that read
// nothing (mode off) is `neutral`, so it never looks like a clean result.
export type PiiTone = "neutral" | "clean" | "findings" | "pending" | "blocked" | "failed" | "transformed";

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
    case "scanned":
      if (isPiiNotScanned(pii)) return "neutral";
      return pii.findingsCount && pii.findingsCount > 0 ? "findings" : "clean";
    default:
      return "neutral";
  }
}

export function canDownloadArtifact(artifact: Artifact): boolean {
  // The backend issues a download token only for an artifact that is ready
  // and has an eligible PII verdict. A pending, blocked or failed scan holds
  // the file.
  return isArtifactEligibleForChatContext(artifact);
}

export function canSelectArtifact(artifact: Artifact): boolean {
  return isArtifactEligibleForChatContext(artifact);
}

export function getArtifactOrigin(artifact: Artifact): { label: string; tone: ArtifactOriginTone } {
  // An origin that an overlay registered keeps its tone for every artifact
  // from it. The tool label still wins, so the user sees who added the file.
  const origin = findArtifactOrigin(artifact.detail?.source);
  const tone = origin?.tone ?? "neutral";
  if (artifact.createdByType === "tool") return { label: "Added by assistant", tone };
  if (origin) return { label: origin.label, tone };
  if (artifact.artifactType === "generated") return { label: "Generated", tone };
  if (artifact.artifactType === "derived") return { label: "Derived", tone };
  return { label: "Uploaded", tone };
}
