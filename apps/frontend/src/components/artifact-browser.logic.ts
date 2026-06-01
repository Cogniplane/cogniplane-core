import {
  ArtifactSortSchema,
  ArtifactBrowseTypeSchema,
  ArtifactBrowseStatusSchema,
  MIME_CLASSES,
  type ArtifactSort
} from "@cogniplane/shared-types";

import type { ArtifactBrowseParams } from "../lib/artifact-api";

export type ArtifactBrowserFilterState = {
  q: string;
  type: string[];
  status: string[];
  mimeClass: string[];
  sort: ArtifactSort;
};

export const EMPTY_ARTIFACT_FILTER_STATE: ArtifactBrowserFilterState = {
  q: "",
  type: [],
  status: [],
  mimeClass: [],
  sort: "created_desc"
};

export const ARTIFACT_TYPE_OPTIONS = ArtifactBrowseTypeSchema.options;
export const ARTIFACT_STATUS_OPTIONS = ArtifactBrowseStatusSchema.options;
export const ARTIFACT_MIME_CLASS_OPTIONS = MIME_CLASSES;
export const ARTIFACT_SORT_OPTIONS = ArtifactSortSchema.options;

export const ARTIFACT_SORT_LABELS: Record<ArtifactSort, string> = {
  created_desc: "Newest first",
  created_asc: "Oldest first",
  name_asc: "Name (A–Z)",
  name_desc: "Name (Z–A)",
  size_desc: "Largest first",
  size_asc: "Smallest first"
};

export const ARTIFACT_MIME_CLASS_LABELS: Record<(typeof MIME_CLASSES)[number], string> = {
  image: "Images",
  pdf: "PDFs",
  text: "Text",
  code: "Code",
  other: "Other"
};

const ARTIFACT_FILTER_KEYS = ["q", "type", "status", "mimeClass", "sort"] as const;

export function artifactSearchHasAnyFilter(params: URLSearchParams): boolean {
  return ARTIFACT_FILTER_KEYS.some((key) => params.has(key));
}

// Validate each member against the schema option list so a hand-edited URL
// can't push a bogus enum value into the request (the backend would 400, but
// dropping it here keeps the UI consistent).
function keepValid(values: string[], allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return values.filter((v) => set.has(v));
}

export function parseArtifactFilterState(params: URLSearchParams): ArtifactBrowserFilterState {
  const sortRaw = params.get("sort") ?? "";
  const sort = (ARTIFACT_SORT_OPTIONS as readonly string[]).includes(sortRaw)
    ? (sortRaw as ArtifactSort)
    : "created_desc";
  return {
    q: params.get("q") ?? "",
    type: keepValid(params.getAll("type"), ARTIFACT_TYPE_OPTIONS),
    status: keepValid(params.getAll("status"), ARTIFACT_STATUS_OPTIONS),
    mimeClass: keepValid(params.getAll("mimeClass"), ARTIFACT_MIME_CLASS_OPTIONS),
    sort
  };
}

export function artifactFilterStateToSearchString(state: ArtifactBrowserFilterState): string {
  const search = new URLSearchParams();
  if (state.q.trim()) search.set("q", state.q.trim());
  for (const value of state.type) search.append("type", value);
  for (const value of state.status) search.append("status", value);
  for (const value of state.mimeClass) search.append("mimeClass", value);
  // Only serialize a non-default sort so a clean browser URL stays clean.
  if (state.sort !== "created_desc") search.set("sort", state.sort);
  return search.toString();
}

// The shape the data hook / API client consumes. Empty arrays and empty q are
// omitted so they don't widen the cache key needlessly.
export function artifactFilterStateToParams(
  state: ArtifactBrowserFilterState
): Omit<ArtifactBrowseParams, "cursor" | "limit"> {
  const params: Omit<ArtifactBrowseParams, "cursor" | "limit"> = { sort: state.sort };
  const q = state.q.trim();
  if (q) params.q = q;
  if (state.type.length) params.type = state.type;
  if (state.status.length) params.status = state.status;
  if (state.mimeClass.length) params.mimeClass = state.mimeClass;
  return params;
}

export function toggleInArray(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
