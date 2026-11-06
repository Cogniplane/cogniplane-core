import { STATUS_SUMMARY_STATUSES } from "@cogniplane/shared-types";
import { describe, expect, it } from "vitest";

import { countLabel, readCounts, STATUS_LABELS, statusHeading, statusLabel } from "./status-summary.logic";

describe("statusLabel", () => {
  it("has a text for every status of the schema, and says when a status is missing", () => {
    expect(Object.keys(STATUS_LABELS)).toEqual([...STATUS_SUMMARY_STATUSES]);
    expect(STATUS_SUMMARY_STATUSES.map((status) => statusLabel(status)))
      .toEqual(["Not started", "In progress", "At risk", "Blocked", "Complete"]);
    expect(statusLabel(undefined)).toBe("Status not reported");
  });
});

describe("counts", () => {
  it("states the pair as given, with no percentage", () => {
    expect(countLabel(3, 8)).toBe("3 of 8 completed");
    expect(countLabel(0, 0)).toBe("0 of 0 completed");
    expect(countLabel(1_200, 1_000_000)).toBe("1,200 of 1,000,000 completed");
    expect(countLabel(3, 8)).not.toContain("%");
  });

  it("reads a pair, and nothing from half of one", () => {
    expect(readCounts({ completed: 0, total: 0 })).toEqual({ completed: 0, total: 0 });
    expect(readCounts({})).toBeNull();
    expect(readCounts({ completed: 2 })).toBeNull();
    expect(readCounts({ total: 2 })).toBeNull();
  });
});

describe("statusHeading", () => {
  it("uses the title on one line, or a plain heading without it", () => {
    expect(statusHeading(" Release\n4.2 ")).toBe("Release 4.2");
    expect(statusHeading(undefined)).toBe("Status summary");
  });
});
