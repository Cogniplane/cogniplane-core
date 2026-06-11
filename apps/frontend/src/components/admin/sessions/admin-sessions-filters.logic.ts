import type {
  AdminSessionAlertKind,
  AdminSessionRow,
  AdminSessionsListParams
} from "@cogniplane/shared-types";

export type SessionsFilterState = {
  userId: string;
  from: string; // ISO datetime or ""
  to: string; // ISO datetime or ""
  status: AdminSessionRow["status"] | "";
  runtime: "codex" | "claude-code" | "";
  alert: AdminSessionAlertKind[];
};

export const EMPTY_FILTER_STATE: SessionsFilterState = {
  userId: "",
  from: "",
  to: "",
  status: "",
  runtime: "",
  alert: []
};

export const ALERT_LABEL: Record<AdminSessionAlertKind, string> = {
  "pii-blocked": "PII blocked",
  "pii-transformed": "PII transformed",
  "pii-detected": "PII detected",
  "approval-rejected": "Approval rejected",
  "approval-pending": "Approval pending",
  errored: "Errored"
};

const PRESET_TOLERANCE_MS = 5 * 60 * 1000; // 5 min slack so a freshly-rendered preset still matches.

export function defaultLast7dRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

export function presetRange(days: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

/**
 * Map a from/to ISO range to a human label. Returns one of the named
 * presets when the span is within 5 minutes of a known duration; falls
 * back to "Custom date" or a YYYY-MM-DD → YYYY-MM-DD literal range.
 * Returns null when no range is set.
 */
export function dateRangeLabel(from: string, to: string): string | null {
  if (!from || !to) {
    if (from || to) return "Custom date";
    return null;
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return "Custom date";
  const span = toMs - fromMs;
  const dayMs = 24 * 60 * 60 * 1000;
  const candidates: Array<{ label: string; days: number }> = [
    { label: "Last 24h", days: 1 },
    { label: "Last 7d", days: 7 },
    { label: "Last 30d", days: 30 }
  ];
  for (const c of candidates) {
    if (Math.abs(span - c.days * dayMs) <= PRESET_TOLERANCE_MS) return c.label;
  }
  // Format as YYYY-MM-DD → YYYY-MM-DD when not a known preset.
  return `${from.slice(0, 10)} → ${to.slice(0, 10)}`;
}

/**
 * Derive the chip list shown in the collapsed filter header. Each chip
 * is a single string ready to render — the component does no further
 * formatting on them.
 */
export function activeFilterChips(state: SessionsFilterState): string[] {
  const chips: string[] = [];
  if (state.userId.trim()) chips.push(`User: ${state.userId.trim()}`);
  const dateLabel = dateRangeLabel(state.from, state.to);
  if (dateLabel) chips.push(dateLabel);
  if (state.status) chips.push(`Status: ${state.status}`);
  if (state.runtime) {
    chips.push(`Runtime: ${state.runtime === "claude-code" ? "Claude Code" : "Codex"}`);
  }
  if (state.alert.length === 1) {
    chips.push(`Alert: ${ALERT_LABEL[state.alert[0]]}`);
  } else if (state.alert.length > 1) {
    chips.push(`Alerts: ${state.alert.length}`);
  }
  return chips;
}

/** ISO datetime → YYYY-MM-DD for the date input. Empty in → empty out. */
export function isoToDateInput(iso: string): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

/**
 * Convert a date input value to an ISO datetime. `endOfDay=true` snaps to
 * 23:59:59Z so a `to` filter inclusive of the chosen day works correctly.
 */
export function dateInputToIso(value: string, endOfDay: boolean): string {
  if (!value) return "";
  return endOfDay ? `${value}T23:59:59Z` : `${value}T00:00:00Z`;
}

/** Strip empty fields from filter state to get the API params shape. */
export function filterStateToParams(state: SessionsFilterState): AdminSessionsListParams {
  const params: AdminSessionsListParams = {};
  if (state.userId.trim()) params.userId = state.userId.trim();
  if (state.from) params.from = state.from;
  if (state.to) params.to = state.to;
  if (state.status) params.status = state.status;
  if (state.runtime) params.runtime = state.runtime;
  if (state.alert.length > 0) params.alert = state.alert;
  return params;
}
