// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PiiActivityMetrics } from "@cogniplane/shared-types";

import { FindingsBreakdown } from "./admin-pii-charts";

afterEach(cleanup);

const kpi = { current: 0, previous: 0 };
function metrics(byConfidence: PiiActivityMetrics["byConfidence"]): PiiActivityMetrics {
  return {
    range: { preset: "7d", from: "2026-09-20T00:00:00Z", to: "2026-09-27T00:00:00Z", bucket: "day" },
    policy: { enabled: true, mode: "detect", rawRetention: "never", scopes: { chatPrompts: true, uploads: true, microsoftImports: false }, entityTypes: [] },
    kpis: { scans: kpi, findings: kpi, blocked: kpi, transformed: kpi, failed: kpi },
    timeSeries: [],
    // Entity counts decide whether the breakdown renders at all.
    byEntityType: [{ entityType: "email", count: 6 }],
    byConfidence,
    bySubjectType: []
  };
}

/** The confidence bar segments of one entity type, as their tooltip texts. */
const segments = (entityType: string) =>
  [...screen.getByRole("img", { name: new RegExp(`^${entityType}:`) }).children].map((segment) => segment.getAttribute("title"));

it("splits each entity type's findings by confidence, with shares that add up", () => {
  render(<FindingsBreakdown data={metrics([
    { entityType: "email", high: 3, medium: 2, low: 1 },
    { entityType: "phone", high: 0, medium: 0, low: 4 }
  ])} />);

  expect(screen.getByRole("img", { name: "email: 3 high, 2 medium, 1 low confidence" })).toBeTruthy();
  expect(segments("email")).toEqual(["high: 3 (50%)", "medium: 2 (33.3%)", "low: 1 (16.7%)"]);
  // Empty levels get no segment.
  expect(segments("phone")).toEqual(["low: 4 (100%)"]);
  const widths = [...screen.getByRole("img", { name: /^email:/ }).children].map((segment) => (segment as HTMLElement).style.width);
  expect(widths).toEqual(["50%", `${(2 / 6) * 100}%`, `${(1 / 6) * 100}%`]);
});

it("skips entity types with no findings, and says when none have a confidence", () => {
  render(<FindingsBreakdown data={metrics([{ entityType: "name", high: 0, medium: 0, low: 0 }, { entityType: "email", high: 1, medium: 0, low: 0 }])} />);
  expect(screen.queryByRole("img", { name: /^name:/ })).toBeNull();
  expect(segments("email")).toEqual(["high: 1 (100%)"]);
  cleanup();

  render(<FindingsBreakdown data={metrics([])} />);
  expect(screen.getByText("By confidence").parentElement!.textContent).toContain("No findings in this range.");
});
