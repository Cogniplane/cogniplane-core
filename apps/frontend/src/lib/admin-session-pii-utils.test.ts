import { describe, expect, test } from "vitest";

import { readPiiScanRunId } from "./admin-session-pii-utils";

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
