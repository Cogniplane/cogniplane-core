export const ARTIFACT_PANE_WIDTH = {
  default: 380,
  min: 320,
  max: 620
} as const;

export function clampArtifactPaneWidth(rectRight: number, clientX: number): number {
  return Math.max(
    ARTIFACT_PANE_WIDTH.min,
    Math.min(ARTIFACT_PANE_WIDTH.max, rectRight - clientX)
  );
}

export function readStoredArtifactPaneWidth(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < ARTIFACT_PANE_WIDTH.min || parsed > ARTIFACT_PANE_WIDTH.max) return null;
  return parsed;
}
