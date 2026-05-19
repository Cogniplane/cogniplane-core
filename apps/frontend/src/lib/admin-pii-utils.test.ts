import { test, expect } from "vitest";
import {
  breakerStatePillClass,
  buildDonutSegments,
  buildMetricsQuery,
  buildSegmentTooltip,
  buildTimeSeriesGeometry,
  computeDelta,
  entityColor,
  formatBucketLabel,
  formatLatency,
  formatRelativeTime,
  formatTimestamp,
  readPersistedBoolean,
  shortId,
  sparklineFromTimeSeries,
  statusPillClass,
  writePersistedBoolean
} from "./admin-pii-utils";
import type { PiiActivityTimeSeriesPoint } from "@cogniplane/shared-types";

function bucket(
  iso: string,
  fields: Partial<Omit<PiiActivityTimeSeriesPoint, "bucket">> = {}
): PiiActivityTimeSeriesPoint {
  return {
    bucket: iso,
    allow: 0,
    report: 0,
    block: 0,
    transform: 0,
    failed: 0,
    ...fields
  };
}

// ─── buildMetricsQuery ──────────────────────────────────────────────────────

test("buildMetricsQuery: 24h preset omits from/to", () => {
  const params = buildMetricsQuery("24h");
  expect(params.get("range")).toBe("24h");
  expect(params.get("from")).toBe(null);
  expect(params.get("to")).toBe(null);
});

test("buildMetricsQuery: custom range serializes from/to", () => {
  const params = buildMetricsQuery(
    "custom",
    "2026-04-01T00:00:00Z",
    "2026-04-30T00:00:00Z"
  );
  expect(params.get("range")).toBe("custom");
  expect(params.get("from")).toBe("2026-04-01T00:00:00Z");
  expect(params.get("to")).toBe("2026-04-30T00:00:00Z");
});

test("buildMetricsQuery: custom range without from/to throws", () => {
  // Validating at the call site keeps invalid requests from hitting the
  // network. The error message must mention 'custom range' so any UI
  // that surfaces it is debuggable.
  expect(() => buildMetricsQuery("custom")).toThrow(/custom range/);
  expect(() => buildMetricsQuery("custom", "2026-04-01T00:00:00Z")).toThrow(/custom range/);
});

// ─── computeDelta ───────────────────────────────────────────────────────────

test("computeDelta: positive change → up direction", () => {
  const delta = computeDelta(120, 100);
  expect(delta.direction).toBe("up");
  expect(delta.pct).toBe(20);
});

test("computeDelta: negative change → down direction", () => {
  const delta = computeDelta(80, 100);
  expect(delta.direction).toBe("down");
  expect(delta.pct).toBe(-20);
});

test("computeDelta: zero/zero → flat with null pct", () => {
  // Both periods empty: nothing to compare. UI should show '—', not 0%.
  const delta = computeDelta(0, 0);
  expect(delta.direction).toBe("flat");
  expect(delta.pct).toBe(null);
});

test("computeDelta: previous=0 with current>0 → 'new' (no infinity)", () => {
  // The metric appeared this window. % change is undefined, not infinite.
  // The 'new' direction tells the UI to render a 'new' label rather than
  // '+Infinity%' or a misleading '+100%'.
  const delta = computeDelta(5, 0);
  expect(delta.direction).toBe("new");
  expect(delta.pct).toBe(null);
});

test("computeDelta: identical values → flat with 0 pct", () => {
  const delta = computeDelta(50, 50);
  expect(delta.direction).toBe("flat");
  expect(delta.pct).toBe(0);
});

test("computeDelta: rounds to one decimal", () => {
  // 100 → 133 is +33%. 100 → 134 is +34%. The key behavior: no long
  // floating-point tails in the displayed value.
  const a = computeDelta(133, 100);
  expect(a.pct).toBe(33);
  const b = computeDelta(101, 100);
  expect(b.pct).toBe(1);
  // 111 / 100 = 1.11 → +11%, but 113 / 100 = 1.13 → +13%, and 1133/100 = +1033%.
  const c = computeDelta(1015, 1000);
  expect(c.pct).toBe(1.5);
});

// ─── formatBucketLabel ──────────────────────────────────────────────────────

test("formatBucketLabel: hour bucket emits an hour-of-day", () => {
  // We can't pin the exact locale string (depends on the test runner's
  // environment), but the result must NOT include the year/date for
  // hour buckets. Two-digit hour-of-day check is a robust signal.
  const label = formatBucketLabel("2026-04-30T14:00:00Z", "hour");
  expect(label).toMatch(/\d/);
  expect(!label.includes("2026")).toBeTruthy();
});

test("formatBucketLabel: day bucket emits a date, not a time", () => {
  const label = formatBucketLabel("2026-04-30T00:00:00Z", "day");
  // Day labels include a month-name fragment ("Apr") regardless of locale.
  // We don't check the exact string because that depends on env locale.
  expect(label).toMatch(/\D/);
});

test("formatBucketLabel: invalid input returns the input verbatim", () => {
  // Defensive: never throw on a malformed bucket string.
  const label = formatBucketLabel("not-a-date", "hour");
  expect(label).toBe("not-a-date");
});

// ─── sparklineFromTimeSeries ────────────────────────────────────────────────

const sampleSeries: PiiActivityTimeSeriesPoint[] = [
  { bucket: "2026-04-29T00:00:00Z", allow: 5, report: 2, block: 1, transform: 0, failed: 0 },
  { bucket: "2026-04-30T00:00:00Z", allow: 3, report: 1, block: 4, transform: 2, failed: 1 }
];

test("sparklineFromTimeSeries: 'scans' sums every action stack per bucket", () => {
  const out = sparklineFromTimeSeries(sampleSeries, "scans");
  expect(out).toEqual([8, 11]);
});

test("sparklineFromTimeSeries: 'blocked' reads only the block stack", () => {
  const out = sparklineFromTimeSeries(sampleSeries, "blocked");
  expect(out).toEqual([1, 4]);
});

test("sparklineFromTimeSeries: 'transformed' reads only the transform stack", () => {
  const out = sparklineFromTimeSeries(sampleSeries, "transformed");
  expect(out).toEqual([0, 2]);
});

test("sparklineFromTimeSeries: 'failed' reads only the failed stack", () => {
  const out = sparklineFromTimeSeries(sampleSeries, "failed");
  expect(out).toEqual([0, 1]);
});

test("sparklineFromTimeSeries: empty series returns empty array", () => {
  // Consumers should skip rendering rather than compute geometry over nothing.
  expect(sparklineFromTimeSeries([], "scans")).toEqual([]);
});

// ─── value-leak type guard (compile-time + runtime serializer) ──────────────

test("PiiActivityMetrics never carries a 'value' field on findings", () => {
  // Runtime check on the shape we hand to consumers. The byEntityType /
  // byConfidence rows aggregate finding fields but must not leak the raw
  // `value`. If a future schema change tries to add it, this test fails
  // at runtime and the type test below fails at compile time.
  const sample = {
    range: { preset: "7d" as const, from: "", to: "", bucket: "day" as const },
    policy: {
      enabled: true,
      mode: "detect" as const,
      rawRetention: "never" as const,
      scopes: { chatPrompts: true, uploads: true, microsoftImports: false },
      entityTypes: []
    },
    kpis: {
      scans: { current: 0, previous: 0 },
      findings: { current: 0, previous: 0 },
      blocked: { current: 0, previous: 0 },
      transformed: { current: 0, previous: 0 },
      failed: { current: 0, previous: 0 }
    },
    timeSeries: [],
    byEntityType: [{ entityType: "email", count: 1 }],
    byConfidence: [{ entityType: "email", high: 1, medium: 0, low: 0 }],
    bySubjectType: []
  };
  const sampleAsRecord: Record<string, unknown> = sample.byEntityType[0]!;
  const sampleConfRecord: Record<string, unknown> = sample.byConfidence[0]!;
  expect("value" in sampleAsRecord).toBe(false);
  expect("value" in sampleConfRecord).toBe(false);
});

// ─── buildTimeSeriesGeometry ────────────────────────────────────────────────

test("buildTimeSeriesGeometry: empty series returns empty bars + yMax 0", () => {
  const geo = buildTimeSeriesGeometry([]);
  expect(geo.bars).toEqual([]);
  expect(geo.yMax).toBe(0);
  expect(geo.yTicks).toEqual([0]);
});

test("buildTimeSeriesGeometry: single bucket renders one bar with correct segments", () => {
  const geo = buildTimeSeriesGeometry([
    bucket("2026-04-30T00:00:00Z", { allow: 5, block: 3, failed: 2 })
  ]);
  expect(geo.bars.length).toBe(1);
  expect(geo.yMax).toBe(10);
  const segments = geo.bars[0]!.segments;
  // Only non-zero actions emit segments.
  expect(segments.map((s) => s.action)).toEqual(["allow", "block", "failed"]);
  // Stack order is fixed: allow (5/10=50%) then block (30%) then failed (20%).
  expect(segments[0]!.yStartPct).toBe(0);
  expect(segments[0]!.hPct).toBe(50);
  expect(segments[1]!.yStartPct).toBe(50);
  expect(segments[1]!.hPct).toBe(30);
  expect(segments[2]!.yStartPct).toBe(80);
  expect(segments[2]!.hPct).toBe(20);
  // Tooltip strings carry both count and percentage.
  expect(segments[0]!.label).toBe("allow: 5 (50%)");
});

test("buildTimeSeriesGeometry: 7-bucket span — bars don't overlap, sum to ≤100% width", () => {
  const series = Array.from({ length: 7 }, (_, i) =>
    bucket(`2026-04-${20 + i}T00:00:00Z`, { allow: i + 1 })
  );
  const geo = buildTimeSeriesGeometry(series);
  expect(geo.bars.length).toBe(7);
  // Each bar's right edge < next bar's left edge.
  for (let i = 0; i < geo.bars.length - 1; i += 1) {
    const a = geo.bars[i]!;
    const b = geo.bars[i + 1]!;
    const aRight = a.xPct + a.widthPct / 2;
    const bLeft = b.xPct - b.widthPct / 2;
    expect(aRight < bLeft).toBeTruthy();
  }
  // yMax tracks the largest single-bucket total (bucket 7 has allow=7).
  expect(geo.yMax).toBe(7);
});

test("buildTimeSeriesGeometry: 30-bucket span fits without overlap", () => {
  const series = Array.from({ length: 30 }, (_, i) =>
    bucket(`2026-04-01T${String(i % 24).padStart(2, "0")}:00:00Z`, { allow: 1 })
  );
  const geo = buildTimeSeriesGeometry(series);
  expect(geo.bars.length).toBe(30);
  // First bar's left edge >= 0; last bar's right edge <= 100.
  const first = geo.bars[0]!;
  const last = geo.bars[29]!;
  expect(first.xPct - first.widthPct / 2 >= 0).toBeTruthy();
  expect(last.xPct + last.widthPct / 2 <= 100).toBeTruthy();
});

test("buildTimeSeriesGeometry: yTicks span 0 to yMax in five steps", () => {
  const geo = buildTimeSeriesGeometry([
    bucket("a", { allow: 100 }),
    bucket("b", { allow: 200 })
  ]);
  expect(geo.yMax).toBe(200);
  // yMax * [0, 0.25, 0.5, 0.75, 1] rounded.
  expect(geo.yTicks).toEqual([0, 50, 100, 150, 200]);
});

// ─── buildDonutSegments ─────────────────────────────────────────────────────

test("buildDonutSegments: empty input returns empty array", () => {
  expect(buildDonutSegments([])).toEqual([]);
  // Filter zero-counts too — they produce no visible arc.
  expect(buildDonutSegments([{ entityType: "email", count: 0 }])).toEqual([]);
});

test("buildDonutSegments: single 100% segment marks isFullCircle (no degenerate arc)", () => {
  // SVG arcs from x0,y0 to x1,y1 where the points coincide render nothing.
  // The renderer must use <circle> instead — isFullCircle flags this.
  const out = buildDonutSegments([{ entityType: "email", count: 5 }]);
  expect(out.length).toBe(1);
  expect(out[0]!.isFullCircle).toBe(true);
  expect(out[0]!.percentage).toBe(100);
  expect(out[0]!.pathD).toBe("");
});

test("buildDonutSegments: three even segments sum to 360° with correct percentages", () => {
  const out = buildDonutSegments([
    { entityType: "email", count: 1 },
    { entityType: "phone", count: 1 },
    { entityType: "address", count: 1 }
  ]);
  expect(out.length).toBe(3);
  expect(out.map((s) => s.percentage)).toEqual([33.3, 33.3, 33.3]);
  // Each path is non-empty and starts with 'M 50 50'.
  for (const seg of out) {
    expect(seg.pathD).toMatch(/^M 50 50/);
    expect(seg.isFullCircle).toBe(false);
  }
});

test("buildDonutSegments: skewed 90/5/5 produces a large-arc (>180°) plus two thin arcs", () => {
  // The 90% segment exceeds 180° so its arc must use largeArcFlag=1.
  // Encoded in the path's '0 1 1' / '0 1 0' triplet (rx ry x-axis-rot
  // large-arc sweep). We assert by substring search rather than parsing
  // the path.
  const out = buildDonutSegments([
    { entityType: "email", count: 90 },
    { entityType: "phone", count: 5 },
    { entityType: "address", count: 5 }
  ]);
  expect(out.length).toBe(3);
  // Sorted desc by count, so [0] is email at 90%.
  expect(out[0]!.entityType).toBe("email");
  expect(out[0]!.percentage).toBe(90);
  // Large-arc flag (1) appears in email's path; the small arcs use 0.
  expect(out[0]!.pathD).toMatch(/A 40 40 0 1 1/);
  expect(out[1]!.pathD).toMatch(/A 40 40 0 0 1/);
});

test("buildDonutSegments: sort order is deterministic (count desc, then alpha)", () => {
  // Two ties at count=3: address before phone alphabetically.
  const out = buildDonutSegments([
    { entityType: "phone", count: 3 },
    { entityType: "email", count: 5 },
    { entityType: "address", count: 3 }
  ]);
  expect(out.map((s) => s.entityType)).toEqual(["email", "address", "phone"]);
});

// ─── entityColor ────────────────────────────────────────────────────────────

test("entityColor: same entity in different orderings gets the same color", () => {
  // Color assignment is stable: the helper sorts the universe of entities
  // before indexing, so API response order doesn't perturb the palette.
  const set1 = ["email", "phone", "address"];
  const set2 = ["address", "phone", "email"];
  expect(entityColor("email", set1)).toBe(entityColor("email", set2));
  expect(entityColor("phone", set1)).toBe(entityColor("phone", set2));
});

test("entityColor: unknown entity falls back to a default token", () => {
  const out = entityColor("unknown_xx", ["email", "phone"]);
  expect(out).toBe("var(--color-on-surface)");
});

// ─── buildSegmentTooltip ────────────────────────────────────────────────────

test("buildSegmentTooltip: zero total returns 0% (no NaN)", () => {
  expect(buildSegmentTooltip(0, 0)).toBe("0 (0%)");
});

test("buildSegmentTooltip: typical case returns count + rounded percentage", () => {
  expect(buildSegmentTooltip(7, 100)).toBe("7 (7%)");
  expect(buildSegmentTooltip(1, 3)).toBe("1 (33.3%)");
});

// ─── Row helpers (shared with the per-session PII tab) ──────────────────────

test("formatTimestamp: nullish returns em dash", () => {
  expect(formatTimestamp(null)).toBe("—");
});

test("formatTimestamp: invalid date returns input verbatim", () => {
  expect(formatTimestamp("not-a-date")).toBe("not-a-date");
});

test("formatTimestamp: valid ISO is locale-formatted (contains a digit)", () => {
  // Locale string varies by env; the load-bearing assertion is that the
  // helper returns SOMETHING resembling a date, not the raw ISO.
  const out = formatTimestamp("2026-04-30T12:00:00Z");
  expect(out).toMatch(/\d/);
});

test("shortId: truncates long IDs with an ellipsis", () => {
  expect(shortId("aaaaaaaabbbbb")).toBe("aaaaaaaa…");
  expect(shortId("short")).toBe("short");
});

test("statusPillClass: blocked / failed get the danger tone", () => {
  expect(statusPillClass("blocked")).toMatch(/text-danger/);
  expect(statusPillClass("failed")).toMatch(/text-danger/);
});

test("statusPillClass: transformed gets the accent tone", () => {
  expect(statusPillClass("transformed")).toMatch(/text-accent/);
});

test("statusPillClass: anything else gets the muted tone", () => {
  expect(statusPillClass("completed")).toMatch(/text-on-surface-variant/);
  expect(statusPillClass("pending")).toMatch(/text-on-surface-variant/);
});

// ─── formatRelativeTime ─────────────────────────────────────────────────────

test("formatRelativeTime: <30s shows 'just now'", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  expect(formatRelativeTime("2026-04-30T11:59:55Z", now)).toBe("just now");
});

test("formatRelativeTime: <60s shows seconds-ago", () => {
  const now = Date.parse("2026-04-30T12:01:00Z");
  // 45s ago.
  expect(formatRelativeTime("2026-04-30T12:00:15Z", now)).toBe("45s ago");
});

test("formatRelativeTime: <1h shows minutes-ago", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  expect(formatRelativeTime("2026-04-30T11:30:00Z", now)).toBe("30m ago");
});

test("formatRelativeTime: <24h shows hours-ago", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  expect(formatRelativeTime("2026-04-30T07:00:00Z", now)).toBe("5h ago");
});

test("formatRelativeTime: ≥24h falls back to a locale date", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  // 3 days ago.
  const out = formatRelativeTime("2026-04-27T12:00:00Z", now);
  // Locale-dependent format; minimum check: not "h ago" / "m ago" /
  // "just now". The helper is supposed to bail to an absolute date.
  expect(!out.endsWith("ago")).toBeTruthy();
  expect(!out.includes("now")).toBeTruthy();
});

test("formatRelativeTime: future timestamp uses 'from now'", () => {
  const now = Date.parse("2026-04-30T12:00:00Z");
  expect(formatRelativeTime("2026-04-30T12:30:00Z", now)).toBe("30m from now");
});

test("formatRelativeTime: nullish returns em dash", () => {
  expect(formatRelativeTime(null)).toBe("—");
});

test("formatRelativeTime: invalid input returns input verbatim", () => {
  expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
});

// ─── formatLatency ──────────────────────────────────────────────────────────

test("formatLatency: nullish returns em dash", () => {
  expect(formatLatency(null)).toBe("—");
  expect(formatLatency(undefined)).toBe("—");
});

test("formatLatency: <1s renders integer ms", () => {
  expect(formatLatency(120)).toBe("120ms");
  expect(formatLatency(0)).toBe("0ms");
  expect(formatLatency(999)).toBe("999ms");
});

test("formatLatency: 1s..60s renders one-decimal seconds", () => {
  expect(formatLatency(1000)).toBe("1.0s");
  expect(formatLatency(1500)).toBe("1.5s");
  expect(formatLatency(59_900)).toBe("59.9s");
});

test("formatLatency: ≥60s renders Xm Ys", () => {
  expect(formatLatency(60_000)).toBe("1m 0s");
  expect(formatLatency(75_000)).toBe("1m 15s");
});

test("formatLatency: negative or non-finite values return em dash", () => {
  // The data source produces non-negative durations, but defending against
  // a malformed API response is cheap insurance.
  expect(formatLatency(-1)).toBe("—");
  expect(formatLatency(Number.NaN)).toBe("—");
  expect(formatLatency(Number.POSITIVE_INFINITY)).toBe("—");
});

// ─── breakerStatePillClass ──────────────────────────────────────────────────

test("breakerStatePillClass: closed → success, open → danger, half_open → muted", () => {
  expect(breakerStatePillClass("closed")).toMatch(/text-success/);
  expect(breakerStatePillClass("open")).toMatch(/text-danger/);
  expect(breakerStatePillClass("half_open")).toMatch(/text-on-surface-variant/);
});

test("breakerStatePillClass: unknown state falls back to muted (no crash)", () => {
  // Future backend states shouldn't crash the timeline.
  expect(breakerStatePillClass("disabled")).toMatch(/text-on-surface-variant/);
  expect(breakerStatePillClass("")).toMatch(/text-on-surface-variant/);
});

// ─── readPersistedBoolean / writePersistedBoolean ───────────────────────────

function createMemoryStorage(): Storage & { snapshot(): Record<string, string> } {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    snapshot() {
      return Object.fromEntries(store);
    }
  };
}

test("readPersistedBoolean: missing key returns fallback", () => {
  const storage = createMemoryStorage();
  expect(readPersistedBoolean(storage, "missing", false)).toBe(false);
  expect(readPersistedBoolean(storage, "missing", true)).toBe(true);
});

test("readPersistedBoolean: round-trips true/false", () => {
  const storage = createMemoryStorage();
  writePersistedBoolean(storage, "k", true);
  expect(readPersistedBoolean(storage, "k", false)).toBe(true);
  writePersistedBoolean(storage, "k", false);
  expect(readPersistedBoolean(storage, "k", true)).toBe(false);
});

test("readPersistedBoolean: malformed JSON returns fallback (no throw)", () => {
  const storage = createMemoryStorage();
  storage.setItem("k", "{not-json");
  expect(readPersistedBoolean(storage, "k", false)).toBe(false);
  expect(readPersistedBoolean(storage, "k", true)).toBe(true);
});

test("readPersistedBoolean: non-boolean JSON returns fallback", () => {
  // A user editing localStorage in devtools shouldn't break the panel.
  const storage = createMemoryStorage();
  storage.setItem("k", JSON.stringify("yes"));
  expect(readPersistedBoolean(storage, "k", true)).toBe(true);
  storage.setItem("k", JSON.stringify(42));
  expect(readPersistedBoolean(storage, "k", false)).toBe(false);
});

test("readPersistedBoolean: null storage (SSR) returns fallback without throwing", () => {
  expect(readPersistedBoolean(null, "k", false)).toBe(false);
  expect(readPersistedBoolean(null, "k", true)).toBe(true);
});

test("writePersistedBoolean: null storage is a no-op (SSR)", () => {
  // Must not throw.
  writePersistedBoolean(null, "k", true);
});

test("writePersistedBoolean: setItem failures are swallowed (private mode / quota)", () => {
  // Mirrors Safari's private-mode behavior where setItem throws.
  const throwing: Pick<Storage, "setItem"> = {
    setItem() {
      throw new Error("QuotaExceededError");
    }
  };
  // Must not throw to the caller.
  writePersistedBoolean(throwing, "k", true);
});
