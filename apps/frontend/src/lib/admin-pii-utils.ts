import type {
  PiiActivityTimeSeriesPoint,
  PiiBucketGranularity,
  PiiRangePreset
} from "@cogniplane/shared-types";

export type PiiKpiKey = "scans" | "findings" | "blocked" | "transformed" | "failed";

export type PiiDeltaDirection = "up" | "down" | "flat" | "new";

export type PiiDelta = {
  /** Percentage change vs previous period. null when previous=0 to avoid divide-by-zero. */
  pct: number | null;
  direction: PiiDeltaDirection;
};

/**
 * Build the query string for /admin/pii/metrics. Validates the
 * preset/from/to combination at the point of request — if a caller passes
 * `custom` without `from`+`to`, throws rather than silently sending an
 * invalid request the backend would reject anyway.
 */
export function buildMetricsQuery(
  range: PiiRangePreset,
  from?: string,
  to?: string
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("range", range);
  if (range === "custom") {
    if (!from || !to) {
      throw new Error("custom range requires both from and to");
    }
    params.set("from", from);
    params.set("to", to);
  }
  return params;
}

/**
 * Compute % delta for a KPI tile.
 *
 * - `flat` when both periods are 0 (nothing happened either way).
 * - `new` when previous=0 but current>0 — the metric appeared this window;
 *   percentage is undefined (∞), so pct is null and the UI shows "new"
 *   instead of a number.
 * - `up`/`down` otherwise, with pct rounded to one decimal place.
 *
 * The flat/new distinction matters for the dashboard: a tile that goes
 * from 0 blocked scans to 1 should NOT render "+Infinity%" or "+100%" —
 * those are both lies. "new" is the truthful label.
 */
export function computeDelta(current: number, previous: number): PiiDelta {
  if (previous === 0 && current === 0) return { pct: null, direction: "flat" };
  if (previous === 0) return { pct: null, direction: "new" };
  const raw = ((current - previous) / previous) * 100;
  const pct = Math.round(raw * 10) / 10;
  let direction: PiiDeltaDirection;
  if (pct > 0) direction = "up";
  else if (pct < 0) direction = "down";
  else direction = "flat";
  return { pct, direction };
}

/**
 * Format a bucket timestamp for the time-series x-axis. Hour buckets show
 * the hour-of-day; day buckets show the date. Both formatters assume the
 * caller's locale via toLocale*String — server-rendered values are ISO
 * strings, so this helper is client-only.
 */
export function formatBucketLabel(iso: string, bucket: PiiBucketGranularity): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (bucket === "hour") {
    return date.toLocaleTimeString(undefined, { hour: "numeric", hour12: false });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Derive a 1-D series for a per-KPI sparkline from the API's stacked
 * timeSeries[].
 *
 * Only the four KPIs that are summable from action_taken stacks are
 * supported here — `findings` is excluded because timeSeries counts scan
 * rows, not finding occurrences. Callers that need a findings sparkline
 * must add a per-bucket `findings` count to the API; this helper would
 * then grow a fifth case.
 *
 * Returns an empty array for an empty time series so the consumer can
 * skip rendering instead of computing geometry over nothing.
 */
export function sparklineFromTimeSeries(
  series: PiiActivityTimeSeriesPoint[],
  metric: Exclude<PiiKpiKey, "findings">
): number[] {
  if (series.length === 0) return [];
  if (metric === "scans") {
    return series.map((p) => p.allow + p.report + p.block + p.transform + p.failed);
  }
  // KPI keys are nominalized (blocked / transformed) while the time series
  // uses the action_taken values (block / transform). Map between them.
  const fieldByKpi: Record<Exclude<PiiKpiKey, "findings" | "scans">, keyof PiiActivityTimeSeriesPoint> = {
    blocked: "block",
    transformed: "transform",
    failed: "failed"
  };
  const field = fieldByKpi[metric];
  return series.map((p) => Number(p[field] ?? 0));
}

// ─── Charts: stacked time series ────────────────────────────────────────────

export const TIME_SERIES_ACTIONS = ["allow", "report", "block", "transform", "failed"] as const;
export type TimeSeriesAction = (typeof TIME_SERIES_ACTIONS)[number];

export type TimeSeriesSegment = {
  action: TimeSeriesAction;
  /** Top edge of this segment within the bar, as % of yMax (0..100). */
  yStartPct: number;
  /** Height of this segment as % of yMax (0..100). */
  hPct: number;
  count: number;
  /** Pre-computed "<count> (<pct>%)" string for the SVG <title> hover hint. */
  label: string;
};

export type TimeSeriesBar = {
  bucket: string;
  /** Center X of the bar, as % across the chart (0..100). */
  xPct: number;
  /** Bar width as % of the chart's width — sized so bars don't overlap. */
  widthPct: number;
  total: number;
  segments: TimeSeriesSegment[];
};

export type TimeSeriesGeometry = {
  bars: TimeSeriesBar[];
  /** The largest single-bucket total, used to drive y-axis scale. */
  yMax: number;
  /** Y-axis tick values (0, 25%, 50%, 75%, 100% of yMax). */
  yTicks: number[];
};

const ACTION_FIELDS: Record<TimeSeriesAction, keyof PiiActivityTimeSeriesPoint> = {
  allow: "allow",
  report: "report",
  block: "block",
  transform: "transform",
  failed: "failed"
};

/**
 * Compute bar / segment geometry for a stacked-bar time-series chart.
 *
 * Coordinates are emitted as percentages (0..100) so the SVG itself stays
 * size-agnostic and CSS owns the rendered dimensions. The caller's viewBox
 * just needs to use 0..100 on the x-axis and 0..yMax on the y-axis.
 *
 * Bar width: equal share of the chart with a small inter-bar gutter. With
 * N bars, bar width = (100 - (N+1) * GUTTER) / N. GUTTER is fixed at 1.5%
 * — narrow enough that 30 bars still read as a series, wide enough that 7
 * bars don't look glued together.
 *
 * Segments stack TOP DOWN so a "block" segment in bucket A and bucket B
 * sit at the same vertical layer regardless of the other actions in each
 * bucket. This lets the eye scan a single action across time without
 * being confused by stack-order changes.
 *
 * Empty input → empty bars array, yMax=0, yTicks=[0]. Consumers should
 * detect this and render an empty-state hint rather than a degenerate chart.
 */
export function buildTimeSeriesGeometry(
  series: PiiActivityTimeSeriesPoint[]
): TimeSeriesGeometry {
  if (series.length === 0) {
    return { bars: [], yMax: 0, yTicks: [0] };
  }
  const totals = series.map(
    (p) => p.allow + p.report + p.block + p.transform + p.failed
  );
  const yMax = Math.max(...totals, 1);

  const N = series.length;
  const GUTTER = 1.5;
  const widthPct = Math.max(0.5, (100 - (N + 1) * GUTTER) / N);

  const bars: TimeSeriesBar[] = series.map((point, i) => {
    const total = totals[i] ?? 0;
    const xPct = GUTTER + i * (widthPct + GUTTER) + widthPct / 2;
    let cumulative = 0;
    const segments: TimeSeriesSegment[] = [];
    // Stack order is fixed by TIME_SERIES_ACTIONS so a segment of the same
    // action always lands at the same vertical layer across all bars.
    for (const action of TIME_SERIES_ACTIONS) {
      const count = Number(point[ACTION_FIELDS[action]] ?? 0);
      if (count === 0) continue;
      const hPct = (count / yMax) * 100;
      const yStartPct = (cumulative / yMax) * 100;
      const pct = total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
      segments.push({
        action,
        yStartPct,
        hPct,
        count,
        label: `${action}: ${count} (${pct}%)`
      });
      cumulative += count;
    }
    return { bucket: point.bucket, xPct, widthPct, total, segments };
  });

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(yMax * p));
  return { bars, yMax, yTicks };
}

// ─── Charts: donut by entityType ────────────────────────────────────────────

export type DonutSegment = {
  entityType: string;
  count: number;
  /** 0..100, rounded to 1 decimal so display strings stay short. */
  percentage: number;
  /** SVG path d-attribute for the arc, pre-built. */
  pathD: string;
  /** True when the segment is the only one — caller draws a circle instead. */
  isFullCircle: boolean;
};

/**
 * Build SVG arc path data for a donut chart from entity-type counts.
 *
 * Uses a fixed unit-radius coordinate system (radius=40 in a 100×100
 * viewBox, centered at 50,50). The caller scales the SVG via CSS.
 *
 * Edge cases:
 * - empty rows → empty array
 * - single segment with 100% → marked isFullCircle so the consumer can
 *   render a `<circle>` instead of an arc path. SVG large-arc semantics
 *   make a full-360° arc render as nothing (start == end coordinates).
 * - segments with count=0 are dropped before geometry — they wouldn't
 *   render anything visible and would clutter the legend.
 */
export function buildDonutSegments(
  rows: Array<{ entityType: string; count: number }>
): DonutSegment[] {
  const filtered = rows.filter((r) => r.count > 0);
  if (filtered.length === 0) return [];
  const total = filtered.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return [];

  // Sort by count desc so the largest slice starts at 12 o'clock; ties
  // broken alphabetically for deterministic output (test stability).
  const sorted = [...filtered].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.entityType.localeCompare(b.entityType);
  });

  // Single-segment fast path: a 360° arc renders as nothing because the
  // start and end points coincide. Mark the segment so the renderer can
  // emit a <circle> instead.
  if (sorted.length === 1) {
    const only = sorted[0]!;
    return [
      {
        entityType: only.entityType,
        count: only.count,
        percentage: 100,
        pathD: "",
        isFullCircle: true
      }
    ];
  }

  const cx = 50;
  const cy = 50;
  const r = 40;
  let angle = -Math.PI / 2; // start at 12 o'clock

  return sorted.map((row) => {
    const slice = (row.count / total) * 2 * Math.PI;
    const startAngle = angle;
    const endAngle = angle + slice;
    angle = endAngle;

    const x0 = cx + r * Math.cos(startAngle);
    const y0 = cy + r * Math.sin(startAngle);
    const x1 = cx + r * Math.cos(endAngle);
    const y1 = cy + r * Math.sin(endAngle);
    // Standard SVG arc large-arc-flag rule. With sweep-flag=1 (clockwise),
    // largeArc=1 when the arc spans more than 180°.
    const largeArc = slice > Math.PI ? 1 : 0;

    const pathD = `M ${cx} ${cy} L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`;
    const percentage = Math.round((row.count / total) * 1000) / 10;

    return {
      entityType: row.entityType,
      count: row.count,
      percentage,
      pathD,
      isFullCircle: false
    };
  });
}

// Categorical palette for entity types. Order is stable so the same entity
// always renders in the same slot when re-querying. Picked from existing
// CSS tokens — no new colors. 6 slots covers the current PII_ENTITY_TYPES
// set; if a 7th type is added, the 7th entity falls back to --on-surface.
const ENTITY_PALETTE = [
  "var(--color-accent)",
  "var(--color-success)",
  "var(--color-danger)",
  "var(--color-warning)",
  "var(--color-on-surface-variant)",
  "var(--color-outline)"
];

/**
 * Map an entity type to a deterministic categorical color. The mapping is
 * keyed by the entity type's index in a stable sorted list — same input
 * always yields the same color, regardless of API response order.
 */
export function entityColor(entityType: string, allEntities: string[]): string {
  const sorted = [...new Set(allEntities)].sort();
  const idx = sorted.indexOf(entityType);
  if (idx < 0) return "var(--color-on-surface)";
  return ENTITY_PALETTE[idx % ENTITY_PALETTE.length] ?? "var(--color-on-surface)";
}

/**
 * Tooltip-string formatter for chart segments. Returns "<count> (<pct>%)"
 * with one-decimal precision; treats zero-total as "0 (0%)" rather than
 * "0 (NaN%)".
 */
export function buildSegmentTooltip(count: number, total: number): string {
  if (total <= 0) return `${count} (0%)`;
  const pct = Math.round((count / total) * 1000) / 10;
  return `${count} (${pct}%)`;
}

// ─── Row helpers shared with the per-session PII tab ────────────────────────

/**
 * Locale-aware absolute timestamp. "—" for nullish input. Catches Invalid
 * Date by falling through to the raw string so a malformed API response
 * doesn't render "Invalid Date" in the table.
 */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

/** Trim long IDs so they fit in a table cell. */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

// Pill base used by status / breaker classifiers. The tone modifiers below
// extend this. Status values come from the backend's pii_scan_runs.status
// CHECK constraint and from the breaker state machine.
const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_RED = `${PILL_BASE} bg-danger-surface text-danger`;
const PILL_BLUE = `${PILL_BASE} bg-accent-soft text-accent`;
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;

/**
 * Tailwind utility classes for a scan run status pill.
 */
export function statusPillClass(status: string): string {
  if (status === "blocked" || status === "failed") return PILL_RED;
  if (status === "transformed") return PILL_BLUE;
  return PILL_GRAY;
}

/**
 * Relative time for "last seen N ago" columns. Future timestamps render
 * as "in Nm" / "just now"; past timestamps as "Nm ago" / "Nh ago" / a
 * locale date for anything older than 24h.
 *
 * Falls through to the raw string on Invalid Date so the table never
 * shows literal "Invalid Date" or "NaN ago".
 */
export function formatRelativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const deltaMs = now - t;
  const absSec = Math.abs(deltaMs) / 1000;
  const direction = deltaMs >= 0 ? "ago" : "from now";
  if (absSec < 30) return "just now";
  if (absSec < 60) return `${Math.round(absSec)}s ${direction}`;
  if (absSec < 3600) return `${Math.round(absSec / 60)}m ${direction}`;
  if (absSec < 86_400) return `${Math.round(absSec / 3600)}h ${direction}`;
  // ≥24h — locale absolute date is more useful than "32h ago".
  try {
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// ─── Ops panel helpers ──────────────────────────────────────────────────────

/**
 * Format a millisecond duration for the latency table. Picks a unit that
 * keeps the number short:
 *   <1000ms → "120ms"
 *   <60s    → "1.2s"
 *   ≥60s    → "1m 5s"
 *
 * Nullish input returns an em dash so empty cells render as "—" rather
 * than "0ms" (which would lie about a missing measurement).
 */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Tailwind utility classes for a breaker-state pill. Unknown states fall
 * back to gray so a future state added on the backend doesn't crash the
 * timeline.
 */
export function breakerStatePillClass(state: string): string {
  if (state === "closed") return PILL_GREEN;
  if (state === "open") return PILL_RED;
  // half_open + anything else: muted treatment.
  return PILL_GRAY;
}

/**
 * Read a boolean from a Storage-like backend, with safe fallbacks. Pure
 * function so it's testable without a DOM. The hook in the ops panel
 * passes window.localStorage on the client and null during SSR.
 *
 * Stored values are JSON-encoded "true"/"false". A malformed value
 * returns the fallback rather than throwing — operators changing the
 * value by hand in devtools shouldn't crash the panel.
 */
export function readPersistedBoolean(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
  fallback: boolean
): boolean {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Companion to readPersistedBoolean. No-op when storage is null (SSR). */
export function writePersistedBoolean(
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  value: boolean
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may throw in private mode or when full. We don't care —
    // the next read just falls back to the default.
  }
}
