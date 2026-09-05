import { describe, expect, test } from "vitest";

import {
  ARTIFACT_PANE_WIDTH,
  clampArtifactPaneWidth,
  readStoredArtifactPaneWidth
} from "./artifact-pane-geometry";

describe("clampArtifactPaneWidth", () => {
  test("clamps to the configured min/max", () => {
    expect(clampArtifactPaneWidth(1000, 50)).toBe(ARTIFACT_PANE_WIDTH.max);
    expect(clampArtifactPaneWidth(500, 490)).toBe(ARTIFACT_PANE_WIDTH.min);
  });

  test("returns the literal width when within bounds", () => {
    expect(clampArtifactPaneWidth(900, 500)).toBe(400);
  });
});

describe("readStoredArtifactPaneWidth", () => {
  test("rejects out-of-range and non-numeric values", () => {
    expect(readStoredArtifactPaneWidth("abc")).toBeNull();
    expect(readStoredArtifactPaneWidth("100")).toBeNull();
    expect(readStoredArtifactPaneWidth("9999")).toBeNull();
    expect(readStoredArtifactPaneWidth(null)).toBeNull();
  });

  test("accepts in-range values", () => {
    expect(readStoredArtifactPaneWidth("400")).toBe(400);
  });
});
