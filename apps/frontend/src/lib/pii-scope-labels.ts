// Labels for PII import scopes. The backend decides which scopes an admin can
// configure: the policy it returns has one boolean for each core scope and
// each import scope that an overlay registered there. An overlay that adds an
// import source registers the label of its scope key here.
//
// Register at module load, from the overlay bootstrap, before any render.

export type PiiScopeLabel = {
  /** Key in the policy `scopes` object. It is persisted, so do not change it. */
  readonly scopeKey: string;
  readonly label: string;
};

const labels: PiiScopeLabel[] = [];

export function registerPiiScopeLabel(entry: PiiScopeLabel): void {
  if (labels.some((item) => item.scopeKey === entry.scopeKey)) return;
  labels.push(entry);
}

/** The registered label, or the key when no overlay in this build labels it. */
export function piiScopeLabel(scopeKey: string): string {
  return labels.find((item) => item.scopeKey === scopeKey)?.label ?? scopeKey;
}
