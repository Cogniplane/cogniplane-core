import { describe, test, expect } from "vitest";

import { extractLifecycleMode } from "./admin-runtime-routes.js";

describe("extractLifecycleMode", () => {
  test.each(["local", "e2b"] as const)(
    "passes '%s' through unchanged",
    (mode) => {
      expect(extractLifecycleMode({ mode })).toBe(mode);
    }
  );

  test.each([
    [{}, null],
    [{ mode: null }, null],
    [{ mode: undefined }, null],
    [{ mode: "remote" }, null], // unknown — guard returns null, not the string
    [{ mode: 42 }, null],
    [{ other: "field" }, null]
  ] as Array<[Record<string, unknown>, "local" | "e2b" | null]>)(
    "returns null for non-recognized mode (input: %j)",
    (input, expected) => {
      expect(extractLifecycleMode(input)).toBe(expected);
    }
  );
});
