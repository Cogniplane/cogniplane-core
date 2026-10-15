import { test, expect } from "vitest";
import { withUtcDateLocale } from "../test-helpers/date-locale";
import { queryKeys } from "./query-keys";

import {
  breakerStatePillClass,
  buildMetricsQuery,
  buildSegmentTooltip,
  computeDelta,
  entityColor,
  formatBucketLabel,
  formatLatency,
  formatRelativeTime,
  isPiiRangeQueryKey,
  readPersistedBoolean,
  shortId,
  sparklineFromTimeSeries,
  statusPillClass,
  writePersistedBoolean
} from "./admin-pii-utils";
import type { PiiActivityTimeSeriesPoint } from "@cogniplane/shared-types";

withUtcDateLocale();

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

test("formatBucketLabel: hour bucket shows its UTC hour", () => {
  expect(formatBucketLabel("2026-04-30T14:00:00Z", "hour")).toBe("14");
});

test("formatBucketLabel: day bucket shows its calendar date", () => {
  expect(formatBucketLabel("2026-04-30T00:00:00Z", "day")).toBe("Apr 30");
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

test("shortId: truncates long IDs with an ellipsis", () => {
  expect(shortId("aaaaaaaabbbbb")).toBe("aaaaaaaa…");
  expect(shortId("short")).toBe("short");
});

test("statusPillClass: blocked / failed get the danger tone", () => {
  expect(statusPillClass("blocked")).toMatch(/text-danger/);
  expect(statusPillClass("failed")).toMatch(/text-danger/);
});

test("statusPillClass: transformed gets the info tone", () => {
  expect(statusPillClass("transformed")).toMatch(/text-info/);
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
  expect(formatRelativeTime("2026-04-27T12:00:00Z", now)).toBe("Apr 27");
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

test("isPiiRangeQueryKey matches every dashboard query of the active range and nothing else", () => {
  const week = { range: "7d" };
  const custom = { range: "custom", from: "2026-09-01", to: "2026-09-30" };

  for (const key of [
    queryKeys.admin.piiMetrics(week),
    queryKeys.admin.piiTop({ ...week, groupBy: "user" }),
    queryKeys.admin.piiRecent({ ...week, limit: 20 }),
    queryKeys.admin.piiJobsStats(week)
  ]) {
    expect(isPiiRangeQueryKey(key, week)).toBe(true);
    expect(isPiiRangeQueryKey(key, { range: "30d" })).toBe(false);
  }
  expect(isPiiRangeQueryKey(queryKeys.admin.piiMetrics(custom), custom)).toBe(true);
  expect(isPiiRangeQueryKey(queryKeys.admin.piiMetrics(custom), { ...custom, to: "2026-10-01" })).toBe(false);
  expect(isPiiRangeQueryKey(queryKeys.admin.piiMetrics(custom), { ...custom, from: "2026-08-31" })).toBe(false);
  // Other admin caches with a matching params object stay untouched.
  expect(isPiiRangeQueryKey(["admin", "users", "list", week], week)).toBe(false);
  expect(isPiiRangeQueryKey(["admin", "pii", "settings", week], week)).toBe(false);
  expect(isPiiRangeQueryKey(["other", "pii", "metrics", week], week)).toBe(false);
  expect(isPiiRangeQueryKey(["admin", "pii", "metrics"], week)).toBe(false);
  expect(isPiiRangeQueryKey(["admin", "pii", "metrics", "7d"], week)).toBe(false);
});
