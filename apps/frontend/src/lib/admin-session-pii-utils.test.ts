import { describe, expect, test } from "vitest";

import { aggregateFindings, readPiiScanRunId, summarizeFindings } from "./admin-session-pii-utils";

describe("readPiiScanRunId", () => {
  test("reads detailJson.pii.scanRunId when present", () => {
    expect(readPiiScanRunId({ pii: { scanRunId: "scan-1" } })).toBe("scan-1");
  });

  test("returns null when shape doesn't match", () => {
    expect(readPiiScanRunId(null)).toBeNull();
    expect(readPiiScanRunId(undefined)).toBeNull();
    expect(readPiiScanRunId("string")).toBeNull();
    expect(readPiiScanRunId({})).toBeNull();
    expect(readPiiScanRunId({ pii: null })).toBeNull();
    expect(readPiiScanRunId({ pii: { scanRunId: 42 } })).toBeNull();
  });
});

describe("aggregateFindings", () => {
  test("groups findings by kind, then type, then entity type, most frequent first", () => {
    expect(aggregateFindings([
      { entityType: "PHONE" },
      { kind: "EMAIL", type: "ignored", entityType: "ignored" },
      { type: "IBAN", entityType: "ignored", count: 3 },
      { kind: "EMAIL" }
    ])).toEqual([
      { label: "IBAN", count: 3 },
      { label: "EMAIL", count: 2 },
      { label: "PHONE", count: 1 }
    ]);
  });

  test("labels a finding without a usable name, and skips values that are not findings", () => {
    expect(aggregateFindings([{ kind: "" }, { kind: 7 }, {}, null, "EMAIL", 3])).toEqual([{ label: "finding", count: 3 }]);
  });

  test("falls through an empty or non-string name to the next one", () => {
    expect(aggregateFindings([{ kind: "", entityType: "EMAIL" }, { kind: 7, type: "PHONE" }])).toEqual([
      { label: "EMAIL", count: 1 },
      { label: "PHONE", count: 1 }
    ]);
  });

  test("counts a finding once unless it carries a numeric count", () => {
    expect(aggregateFindings([{ kind: "EMAIL", count: "4" }, { kind: "EMAIL", count: 2 }])).toEqual([{ label: "EMAIL", count: 3 }]);
  });
});

describe("summarizeFindings", () => {
  test("names each group with its count, in plural when needed", () => {
    expect(summarizeFindings([{ kind: "EMAIL" }, { kind: "PHONE", count: 2 }])).toBe("2 PHONEs, 1 EMAIL");
  });

  test("falls back to the raw number of findings when none can be grouped", () => {
    expect(summarizeFindings(["a", "b"])).toBe("2 findings");
    expect(summarizeFindings([null])).toBe("1 finding");
    expect(summarizeFindings([])).toBe("0 findings");
  });
});
