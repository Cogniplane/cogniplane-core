// Artifact origin registration. An overlay that imports files into a session
// registers the `detail.source` value that its import route stores on each
// artifact. The artifact panel then shows the label and tone of that origin.
// Without a registered origin, the panel shows only the core labels.
//
// Register at module load, from the overlay bootstrap, before any render.

export type ArtifactOriginTone = "accent" | "neutral";

export type ArtifactOrigin = {
  /** Stored `artifact.detail.source` value. It is persisted, so do not change it. */
  readonly detailSource: string;
  /** Label for an artifact that a user imported from this origin. */
  readonly label: string;
  readonly tone: ArtifactOriginTone;
};

const origins: ArtifactOrigin[] = [];

export function registerArtifactOrigin(origin: ArtifactOrigin): void {
  if (origins.some((o) => o.detailSource === origin.detailSource)) return;
  origins.push(origin);
}

export function findArtifactOrigin(detailSource: unknown): ArtifactOrigin | null {
  if (typeof detailSource !== "string") return null;
  return origins.find((o) => o.detailSource === detailSource) ?? null;
}
