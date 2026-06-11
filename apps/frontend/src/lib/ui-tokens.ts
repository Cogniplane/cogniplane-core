/**
 * Shared Tailwind class tokens for the recurring pill/badge/label/list shapes.
 * These were previously copy-pasted as local consts across ~24 components —
 * edit here, not at the call site, so the admin surfaces stay visually
 * consistent.
 */

export const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
export const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
export const PILL_BLUE = `${PILL_BASE} bg-accent-soft text-accent`;
export const PILL_RED = `${PILL_BASE} bg-danger-surface text-danger`;
export const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;
export const PILL_AMBER = `${PILL_BASE} bg-warning-surface text-warning`;

export const HINT = "text-sm text-on-surface-faint";
export const LIST_ITEM = "rounded-lg border border-outline-variant bg-surface-container-lowest p-3";
export const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
