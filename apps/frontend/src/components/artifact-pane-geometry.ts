// Width rules for the workspace frame. The chat column keeps a readable width.
// A panel goes beside it only when the panel and the chat both fit in the
// measured space. Otherwise the panel covers the chat as a modal drawer.

export const ARTIFACT_PANE_WIDTH = {
  default: 380,
  min: 320,
  max: 620
} as const;

/** The narrowest chat column that the frame keeps beside an inline panel. */
export const MIN_CHAT_WIDTH = 480;

/** The resize handle between the chat and the artifacts panel. */
export const ARTIFACT_PANE_SEPARATOR_WIDTH = 4;

/** One arrow key press on the resize handle. */
export const ARTIFACT_PANE_KEY_STEP = 16;

export type PanePresentation = "inline" | "overlay";

export type ArtifactPaneLayout = {
  presentation: PanePresentation;
  /** The width in effect for an inline panel. The stored preference can be wider. */
  width: number;
  /** The widest inline panel that leaves the chat its minimum width. */
  maxWidth: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Where the artifacts panel goes and how wide it is.
 *
 * `mainWidth` is the measured width of the workspace beside the session
 * sidebar, or null before the first measurement. Without a measurement the
 * 768px breakpoint decides, as the CSS does. `preferredWidth` is the width that
 * the user dragged or stored. It is not changed here: a wider window gives the
 * panel that width again.
 */
export function resolveArtifactPaneLayout(input: {
  mainWidth: number | null;
  preferredWidth: number;
  mobile: boolean;
}): ArtifactPaneLayout {
  const { min, max } = ARTIFACT_PANE_WIDTH;
  const preferred = clamp(input.preferredWidth, min, max);
  if (input.mobile) return { presentation: "overlay", width: preferred, maxWidth: max };
  if (input.mainWidth === null) return { presentation: "inline", width: preferred, maxWidth: max };
  const room = Math.floor(input.mainWidth - ARTIFACT_PANE_SEPARATOR_WIDTH - MIN_CHAT_WIDTH);
  if (room < min) return { presentation: "overlay", width: preferred, maxWidth: max };
  const maxWidth = Math.min(max, room);
  return { presentation: "inline", width: clamp(preferred, min, maxWidth), maxWidth };
}

/** The panel width for a drag that is at `clientX`, with the panel against
 *  `rectRight`. `maxWidth` is the limit from `resolveArtifactPaneLayout`. */
export function clampArtifactPaneWidth(
  rectRight: number,
  clientX: number,
  maxWidth: number = ARTIFACT_PANE_WIDTH.max
): number {
  return clamp(rectRight - clientX, ARTIFACT_PANE_WIDTH.min, maxWidth);
}

/**
 * The panel width after a key on the resize handle, or null for a key that
 * the handle does not use. The handle is between the chat on the left and the
 * panel on the right, so ArrowLeft makes the panel wider. Home gives the
 * smallest panel and End the largest that fits.
 */
export function keyedArtifactPaneWidth(width: number, key: string, maxWidth: number): number | null {
  const { min } = ARTIFACT_PANE_WIDTH;
  switch (key) {
    case "ArrowLeft": return clamp(width + ARTIFACT_PANE_KEY_STEP, min, maxWidth);
    case "ArrowRight": return clamp(width - ARTIFACT_PANE_KEY_STEP, min, maxWidth);
    case "Home": return min;
    case "End": return Math.max(min, maxWidth);
    default: return null;
  }
}

export function readStoredArtifactPaneWidth(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < ARTIFACT_PANE_WIDTH.min || parsed > ARTIFACT_PANE_WIDTH.max) return null;
  return parsed;
}

/** The generated-view panel takes min(45%, 420px) of the chat host row. */
export function generatedViewPanelWidth(hostWidth: number): number {
  return Math.min(hostWidth * 0.45, 420);
}

/** The generated-view panel goes beside the chat only when the chat keeps its
 *  minimum width next to it. */
export function generatedViewFitsBeside(hostWidth: number): boolean {
  return hostWidth - generatedViewPanelWidth(hostWidth) >= MIN_CHAT_WIDTH;
}
