import type {
  AdminSkill,
  SkillMarketplaceEntry,
  SkillRevision
} from "@cogniplane/shared-types";

export type GithubImportDraft = {
  githubUrl: string;
  ref: string;
  subdirectory: string;
};

export const emptyGithubImportDraft: GithubImportDraft = {
  githubUrl: "",
  ref: "",
  subdirectory: ""
};

export const FILE_LIST_COLLAPSED_LIMIT = 8;

export function formatRevisionLabel(revision: SkillRevision): string {
  const source =
    revision.sourceType === "github" ? "GitHub" : revision.sourceType === "zip" ? "ZIP" : revision.sourceType;
  return `r${revision.revisionNumber} - ${source}`;
}

export function describeSkillState(skill: AdminSkill): string {
  return skill.activeBundleName
    ? `Bundle ${skill.activeBundleName} from ${skill.activeSourceType ?? "unknown source"}`
    : "Bundle metadata unavailable";
}

export interface RevisionFile {
  path: string;
  sizeBytes: number;
}

type MetadataLookup<T> = { found: true; value: T } | { found: false };

export function readMetadataAs<T>(
  revision: SkillRevision,
  key: string,
  isT: (value: unknown) => value is T
): MetadataLookup<T> {
  if (!(key in revision.metadata)) {
    return { found: false };
  }
  const raw = revision.metadata[key];
  if (!isT(raw)) {
    return { found: false };
  }
  return { found: true, value: raw };
}

function isRevisionFile(value: unknown): value is RevisionFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { sizeBytes?: unknown }).sizeBytes === "number"
  );
}

function isRevisionFileArray(value: unknown): value is RevisionFile[] {
  return Array.isArray(value) && value.every(isRevisionFile);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

type GithubMetadata = {
  url: string;
  ref?: string;
  subdirectory?: string | null;
};

function isGithubMetadata(value: unknown): value is GithubMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.url !== "string") {
    return false;
  }
  if (candidate.ref !== undefined && typeof candidate.ref !== "string") {
    return false;
  }
  if (
    candidate.subdirectory !== undefined &&
    candidate.subdirectory !== null &&
    typeof candidate.subdirectory !== "string"
  ) {
    return false;
  }
  return true;
}

export function getRevisionFiles(revision: SkillRevision): RevisionFile[] {
  const result = readMetadataAs(revision, "files", isRevisionFileArray);
  return result.found ? result.value : [];
}

export function getRevisionGithubMetadata(revision: SkillRevision): GithubMetadata | null {
  const result = readMetadataAs(revision, "github", isGithubMetadata);
  return result.found ? result.value : null;
}

export function getRevisionAllowedTools(revision: SkillRevision): string[] {
  const result = readMetadataAs(revision, "allowedTools", isStringArray);
  return result.found ? result.value : [];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMarketplaceDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleDateString();
}

const PILL_BASE =
  "inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[0.64rem] font-bold uppercase tracking-[0.06em]";

export function getMarketplaceReviewPillClass(
  reviewStatus: SkillMarketplaceEntry["reviewStatus"]
): string {
  switch (reviewStatus) {
    case "official":
      return `${PILL_BASE} bg-success-surface text-success`;
    case "reviewed":
      return `${PILL_BASE} bg-accent-soft text-accent`;
    case "community":
      return `${PILL_BASE} bg-surface-container text-on-surface-variant`;
    case "experimental":
      return `${PILL_BASE} bg-danger-surface text-danger`;
  }
}
