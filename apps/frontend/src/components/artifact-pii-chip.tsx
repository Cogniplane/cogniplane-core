import type { ArtifactPiiDetail } from "@cogniplane/shared-types";

import { formatPiiLabel, piiTone } from "./artifact-panel.logic";

const PII_TONE_CLASS: Record<ReturnType<typeof piiTone>, string> = {
  pending: "bg-info-surface text-info",
  blocked: "bg-danger-surface text-danger",
  failed: "bg-danger-surface text-danger",
  transformed: "bg-success-surface text-success",
  findings: "bg-warning-surface text-warning",
  clean: "bg-success-surface text-success",
  neutral: "bg-[var(--artifact-chip-surface,var(--color-surface-container))] text-on-surface-variant"
};

/** The PII verdict of an artifact, as the artifact panel shows it. */
export function PiiChip({ pii }: { pii: ArtifactPiiDetail }) {
  const label = formatPiiLabel(pii);
  if (!label) return null;
  const tone = PII_TONE_CLASS[piiTone(pii)];
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
  );
}
