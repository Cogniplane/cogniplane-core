import { expect, test } from "vitest";

import {
  MicrosoftInvalidIdError,
  assertValidGraphId,
  isValidGraphId
} from "./graph-id-validation.js";

test("isValidGraphId accepts typical drive and item IDs", () => {
  expect(isValidGraphId("b!AbCdEf-_1234")).toBe(true);
  expect(isValidGraphId("01ABCDEF1234567890")).toBe(true);
  expect(isValidGraphId("root")).toBe(true);
});

test("isValidGraphId accepts composite SharePoint site IDs with commas and dots", () => {
  expect(isValidGraphId("contoso.sharepoint.com,abc-123,def-456")).toBe(true);
});

test("isValidGraphId rejects values containing path or query separators", () => {
  for (const bad of [
    "drive/items/secret",
    "drive?ref=evil",
    "drive&x=y",
    "drive:Secret.docx",
    "drive#fragment",
    "drive item",
    "../etc/passwd",
    "drive%2Fitems",
    ""
  ]) {
    expect(isValidGraphId(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
  }
});

test("assertValidGraphId throws MicrosoftInvalidIdError on invalid input with field name", () => {
  expect(() => assertValidGraphId("a/b", "driveId")).toThrow(MicrosoftInvalidIdError);
  try {
    assertValidGraphId("a/b", "driveId");
  } catch (err) {
    expect(err).toBeInstanceOf(MicrosoftInvalidIdError);
    expect((err as MicrosoftInvalidIdError).field).toBe("driveId");
    expect((err as Error).message).toContain("driveId");
  }
});

test.each(["/root", "root/", "?root", "root?", " root", "root "])(
  "isValidGraphId rejects an invalid prefix or suffix: %s", (value) => {
    expect(isValidGraphId(value)).toBe(false);
  }
);

test.each([".", "..", "..."])("rejects the dot segment %j, which the URL parser would remove", (value) => {
  expect(isValidGraphId(value)).toBe(false);
  expect(() => assertValidGraphId(value, "driveId")).toThrow(MicrosoftInvalidIdError);
});

test("accepts ids that contain dots among other characters", () => {
  expect(isValidGraphId("contoso.sharepoint.com,1234,5678")).toBe(true);
  expect(isValidGraphId("a.b")).toBe(true);
});
