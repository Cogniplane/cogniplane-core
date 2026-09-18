import { test, expect } from "vitest";

import { mergeCoverage, formatReport, type CoverageSummary } from "./merge-coverage.js";

function summary(files: Record<string, [covered: number, total: number]>): CoverageSummary {
  return Object.fromEntries(
    Object.entries(files).map(([path, [covered, total]]) => [path, { lines: { covered, total } }]),
  );
}

test("a file the integration suite covers better reports the higher count", () => {
  const result = mergeCoverage(
    summary({ "/repo/src/project-store.ts": [4, 100] }),
    summary({ "/repo/src/project-store.ts": [100, 100] }),
  );

  expect(result.unitPct).toBe(4);
  expect(result.mergedPct).toBe(100);
  expect(result.improved.map((file) => file.path)).toEqual(["/repo/src/project-store.ts"]);
});

test("covered lines are not summed, so a line covered by both suites counts once", () => {
  const result = mergeCoverage(
    summary({ "/repo/src/a.ts": [60, 100] }),
    summary({ "/repo/src/a.ts": [60, 100] }),
  );

  // Summing would report 120/100. The maximum keeps it at 60.
  expect(result.mergedCovered).toBe(60);
  expect(result.mergedPct).toBe(60);
});

test("a file the unit suite covers better keeps its unit count", () => {
  const result = mergeCoverage(
    summary({ "/repo/src/a.ts": [90, 100] }),
    summary({ "/repo/src/a.ts": [10, 100] }),
  );

  expect(result.mergedCovered).toBe(90);
  expect(result.improved).toEqual([]);
});

test("a file absent from the integration run keeps its unit count", () => {
  const result = mergeCoverage(summary({ "/repo/src/a.ts": [30, 100] }), summary({}));

  expect(result.mergedPct).toBe(30);
  expect(result.improved).toEqual([]);
});

test("the denominator ignores files the integration run has but the unit run does not", () => {
  const result = mergeCoverage(
    summary({ "/repo/src/a.ts": [50, 100] }),
    summary({ "/repo/src/a.ts": [50, 100], "/repo/src/only-integration.ts": [80, 400] }),
  );

  // Staying on the unit file list keeps the number comparable with the gate.
  expect(result.total).toBe(100);
});

test("the synthetic total row never enters the denominator", () => {
  const unit = summary({ "/repo/src/a.ts": [50, 100] });
  unit.total = { lines: { covered: 50, total: 100 } };

  const result = mergeCoverage(unit, summary({}));

  // Counting it would double every figure.
  expect(result.total).toBe(100);
});

test("a file whose runs disagree on line totals keeps its unit count and is reported", () => {
  const result = mergeCoverage(
    summary({ "/repo/src/a.ts": [10, 100] }),
    summary({ "/repo/src/a.ts": [90, 90] }),
  );

  // 90 covered out of a different total is not comparable, so it must not be
  // read as 90/100.
  expect(result.mergedCovered).toBe(10);
  expect(result.mismatched).toEqual(["/repo/src/a.ts"]);
});

test("files are ranked by how much the integration suite adds", () => {
  const result = mergeCoverage(
    summary({ "/repo/src/small.ts": [80, 100], "/repo/src/large.ts": [10, 100] }),
    summary({ "/repo/src/small.ts": [90, 100], "/repo/src/large.ts": [95, 100] }),
  );

  expect(result.improved.map((file) => file.path)).toEqual([
    "/repo/src/large.ts",
    "/repo/src/small.ts",
  ]);
});

test("an empty denominator reports 100 rather than dividing by zero", () => {
  const result = mergeCoverage(summary({}), summary({}));

  expect(result.mergedPct).toBe(100);
  expect(Number.isNaN(result.mergedPct)).toBe(false);
});

test("the report states both figures and marks itself advisory", () => {
  const report = formatReport(
    mergeCoverage(
      summary({ "/repo/src/project-store.ts": [4, 100] }),
      summary({ "/repo/src/project-store.ts": [100, 100] }),
    ),
    "/repo",
  );

  expect(report).toContain("4%");
  expect(report).toContain("100%");
  expect(report).toContain("src/project-store.ts");
  // A reader must not mistake this for a gate.
  expect(report).toContain("Advisory only");
});

test("the report says so when the integration suite adds nothing", () => {
  const report = formatReport(
    mergeCoverage(summary({ "/repo/src/a.ts": [50, 100] }), summary({})),
    "/repo",
  );

  expect(report).toContain("No file gains coverage");
});
