import { describe, expect, test } from "vitest";

import {
  ARTIFACT_PANE_SEPARATOR_WIDTH,
  ARTIFACT_PANE_WIDTH,
  MIN_CHAT_WIDTH,
  clampArtifactPaneWidth,
  generatedViewFitsBeside,
  keyedArtifactPaneWidth,
  readStoredArtifactPaneWidth,
  resolveArtifactPaneLayout
} from "./artifact-pane-geometry";

describe("clampArtifactPaneWidth", () => {
  test("clamps to the configured min/max", () => {
    expect(clampArtifactPaneWidth(1000, 50)).toBe(ARTIFACT_PANE_WIDTH.max);
    expect(clampArtifactPaneWidth(500, 490)).toBe(ARTIFACT_PANE_WIDTH.min);
  });

  test("returns the literal width when within bounds", () => {
    expect(clampArtifactPaneWidth(900, 500)).toBe(400);
  });

  test("stops a drag at the width that leaves the chat its minimum", () => {
    expect(clampArtifactPaneWidth(1000, 100, 516)).toBe(516);
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

// The shell measures the workspace beside the session sidebar. Below 768px
// the sidebar is a drawer, so the workspace has the full viewport.
const SIDEBAR = 280;
function workspace(viewport: number, sidebarOpen: boolean) {
  const mobile = viewport < 768;
  return { mobile, mainWidth: mobile || !sidebarOpen ? viewport : viewport - SIDEBAR };
}

describe("resolveArtifactPaneLayout", () => {
  // viewport, sidebar open, stored width -> presentation, width in effect
  const matrix: Array<[number, boolean, number, "inline" | "overlay", number | null]> = [
    [320, false, 380, "overlay", null],
    [390, true, 620, "overlay", null],
    [768, true, 380, "overlay", null],
    [768, true, 620, "overlay", null],
    [768, false, 380, "overlay", null],
    [768, false, 620, "overlay", null],
    [1024, true, 380, "overlay", null],
    [1024, true, 620, "overlay", null],
    [1024, false, 320, "inline", 320],
    [1024, false, 380, "inline", 380],
    [1024, false, 620, "inline", 540],
    [1280, true, 380, "inline", 380],
    [1280, true, 620, "inline", 516],
    [1280, false, 380, "inline", 380],
    [1280, false, 620, "inline", 620]
  ];

  test.each(matrix)("%ipx, sidebar open %s, stored %ipx: %s", (viewport, sidebarOpen, stored, presentation, width) => {
    const { mobile, mainWidth } = workspace(viewport, sidebarOpen);
    const layout = resolveArtifactPaneLayout({ mainWidth, preferredWidth: stored, mobile });
    expect(layout.presentation).toBe(presentation);
    if (presentation === "inline") {
      expect(layout.width).toBe(width);
      // The chat keeps its minimum width, and the panel never leaves the workspace.
      expect(mainWidth - ARTIFACT_PANE_SEPARATOR_WIDTH - layout.width).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH);
      expect(layout.width).toBeGreaterThanOrEqual(ARTIFACT_PANE_WIDTH.min);
    }
  });

  test("keeps the CSS breakpoint behavior before the first measurement", () => {
    expect(resolveArtifactPaneLayout({ mainWidth: null, preferredWidth: 620, mobile: false }))
      .toEqual({ presentation: "inline", width: 620, maxWidth: ARTIFACT_PANE_WIDTH.max });
    expect(resolveArtifactPaneLayout({ mainWidth: null, preferredWidth: 380, mobile: true }).presentation).toBe("overlay");
  });

  test("goes inline at the first width with room for the smallest panel", () => {
    const edge = MIN_CHAT_WIDTH + ARTIFACT_PANE_SEPARATOR_WIDTH + ARTIFACT_PANE_WIDTH.min;
    expect(resolveArtifactPaneLayout({ mainWidth: edge - 1, preferredWidth: 380, mobile: false }).presentation).toBe("overlay");
    expect(resolveArtifactPaneLayout({ mainWidth: edge, preferredWidth: 380, mobile: false }))
      .toEqual({ presentation: "inline", width: ARTIFACT_PANE_WIDTH.min, maxWidth: ARTIFACT_PANE_WIDTH.min });
  });
});

describe("keyedArtifactPaneWidth", () => {
  test("steps with the arrows, and Home and End go to the limits that fit", () => {
    expect(keyedArtifactPaneWidth(380, "ArrowLeft", 516)).toBe(396);
    expect(keyedArtifactPaneWidth(380, "ArrowRight", 516)).toBe(364);
    expect(keyedArtifactPaneWidth(510, "ArrowLeft", 516)).toBe(516);
    expect(keyedArtifactPaneWidth(325, "ArrowRight", 516)).toBe(ARTIFACT_PANE_WIDTH.min);
    expect(keyedArtifactPaneWidth(380, "Home", 516)).toBe(ARTIFACT_PANE_WIDTH.min);
    expect(keyedArtifactPaneWidth(380, "End", 516)).toBe(516);
    expect(keyedArtifactPaneWidth(380, "Enter", 516)).toBeNull();
  });
});

describe("generatedViewFitsBeside", () => {
  test("needs room for the panel and the minimum chat width", () => {
    // At 768px with both shell panels open, the host row is 104px. The panel must not fit beside it.
    expect(generatedViewFitsBeside(104)).toBe(false);
    expect(generatedViewFitsBeside(744)).toBe(false);
    expect(generatedViewFitsBeside(1000)).toBe(true);
    expect(generatedViewFitsBeside(1280)).toBe(true);
  });
});
