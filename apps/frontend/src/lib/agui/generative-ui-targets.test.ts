import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";
import { describe, expect, it } from "vitest";

import { canonicalTarget, PARKED_PANEL_TARGET, REMOVED_PANEL_TARGET } from "./generative-ui-targets";

describe("canonicalTarget", () => {
  it("reads a parked panel view as a panel view, and leaves every other target alone", () => {
    expect(canonicalTarget(PARKED_PANEL_TARGET)).toBe(GENERATIVE_UI_PANEL_TARGET);
    expect(canonicalTarget(GENERATIVE_UI_PANEL_TARGET)).toBe(GENERATIVE_UI_PANEL_TARGET);
    expect(canonicalTarget("chat")).toBe("chat");
    expect(canonicalTarget(`${GENERATIVE_UI_PANEL_TARGET}:withdrawn`)).toBe(`${GENERATIVE_UI_PANEL_TARGET}:withdrawn`);
    expect(canonicalTarget(REMOVED_PANEL_TARGET)).toBe(REMOVED_PANEL_TARGET);
  });

  it("parks under a target that the backend never accepts", () => {
    expect(PARKED_PANEL_TARGET).not.toBe(GENERATIVE_UI_PANEL_TARGET);
    expect(PARKED_PANEL_TARGET.startsWith(`${GENERATIVE_UI_PANEL_TARGET}:`)).toBe(true);
  });
});
