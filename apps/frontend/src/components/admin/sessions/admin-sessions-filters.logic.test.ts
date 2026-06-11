import { describe, expect, test } from "vitest";

import {
  activeFilterChips,
  dateInputToIso,
  dateRangeLabel,
  defaultLast7dRange,
  EMPTY_FILTER_STATE,
  filterStateToParams,
  isoToDateInput,
  presetRange
} from "./admin-sessions-filters.logic";

describe("dateRangeLabel", () => {
  test("returns null when no range is set", () => {
    expect(dateRangeLabel("", "")).toBeNull();
  });

  test("returns 'Custom date' when only one bound is set", () => {
    expect(dateRangeLabel("2026-05-01T00:00:00Z", "")).toBe("Custom date");
    expect(dateRangeLabel("", "2026-05-01T00:00:00Z")).toBe("Custom date");
  });

  test("recognizes preset spans within 5 min tolerance", () => {
    const to = "2026-05-09T12:00:00Z";
    const from24h = "2026-05-08T12:02:00Z"; // ~24h - 2min
    const from7d = "2026-05-02T12:00:00Z";
    const from30d = "2026-04-09T12:00:00Z";
    expect(dateRangeLabel(from24h, to)).toBe("Last 24h");
    expect(dateRangeLabel(from7d, to)).toBe("Last 7d");
    expect(dateRangeLabel(from30d, to)).toBe("Last 30d");
  });

  test("falls back to YYYY-MM-DD → YYYY-MM-DD for non-preset spans", () => {
    expect(dateRangeLabel("2026-01-01T00:00:00Z", "2026-03-15T00:00:00Z")).toBe(
      "2026-01-01 → 2026-03-15"
    );
  });

  test("returns 'Custom date' for invalid ISO inputs", () => {
    expect(dateRangeLabel("not-a-date", "also-not")).toBe("Custom date");
  });
});

describe("activeFilterChips", () => {
  test("returns empty array when state is empty", () => {
    expect(activeFilterChips(EMPTY_FILTER_STATE)).toEqual([]);
  });

  test("includes user chip when userId is set (trimmed)", () => {
    const chips = activeFilterChips({ ...EMPTY_FILTER_STATE, userId: "  alice  " });
    expect(chips).toContain("User: alice");
  });

  test("renders single-alert label by name; multi as count", () => {
    const single = activeFilterChips({
      ...EMPTY_FILTER_STATE,
      alert: ["pii-blocked"]
    });
    expect(single).toContain("Alert: PII blocked");

    const multi = activeFilterChips({
      ...EMPTY_FILTER_STATE,
      alert: ["pii-blocked", "errored"]
    });
    expect(multi).toContain("Alerts: 2");
  });

  test("renames runtime values to user-facing labels", () => {
    const codex = activeFilterChips({ ...EMPTY_FILTER_STATE, runtime: "codex" });
    expect(codex).toContain("Runtime: Codex");
    const claude = activeFilterChips({ ...EMPTY_FILTER_STATE, runtime: "claude-code" });
    expect(claude).toContain("Runtime: Claude Code");
  });
});

describe("isoToDateInput / dateInputToIso", () => {
  test("isoToDateInput slices to YYYY-MM-DD", () => {
    expect(isoToDateInput("2026-05-09T12:34:56Z")).toBe("2026-05-09");
    expect(isoToDateInput("")).toBe("");
  });

  test("dateInputToIso snaps to start or end of day", () => {
    expect(dateInputToIso("2026-05-09", false)).toBe("2026-05-09T00:00:00Z");
    expect(dateInputToIso("2026-05-09", true)).toBe("2026-05-09T23:59:59Z");
    expect(dateInputToIso("", false)).toBe("");
  });
});

describe("filterStateToParams", () => {
  test("strips empty fields", () => {
    expect(filterStateToParams(EMPTY_FILTER_STATE)).toEqual({});
  });

  test("forwards non-empty fields and trims userId", () => {
    const params = filterStateToParams({
      userId: "  alice  ",
      from: "2026-05-01T00:00:00Z",
      to: "2026-05-09T23:59:59Z",
      status: "active",
      runtime: "codex",
      alert: ["pii-blocked", "errored"]
    });
    expect(params).toEqual({
      userId: "alice",
      from: "2026-05-01T00:00:00Z",
      to: "2026-05-09T23:59:59Z",
      status: "active",
      runtime: "codex",
      alert: ["pii-blocked", "errored"]
    });
  });

  test("omits userId when only whitespace", () => {
    expect(filterStateToParams({ ...EMPTY_FILTER_STATE, userId: "   " })).toEqual({});
  });
});

describe("defaultLast7dRange / presetRange", () => {
  test("defaultLast7dRange spans approximately 7 days", () => {
    const r = defaultLast7dRange();
    const span = Date.parse(r.to) - Date.parse(r.from);
    expect(Math.abs(span - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(1000);
  });

  test("presetRange spans the requested number of days", () => {
    const r = presetRange(30);
    const span = Date.parse(r.to) - Date.parse(r.from);
    expect(Math.abs(span - 30 * 24 * 60 * 60 * 1000)).toBeLessThan(1000);
  });
});
