import { describe, expect, it } from "vitest";

import { listSettingsLiveSections, listSettingsNavigationItems, registerSettingsSection } from "./settings-sections";

describe("settings navigation", () => {
  it("keeps provider routes registered under one Connected accounts navigation item", () => {
    registerSettingsSection({ id: "microsoft", label: "Microsoft 365", kind: "integration" });

    expect(listSettingsNavigationItems().map((item) => item.id)).toEqual([
      "connections", "capabilities", "skill-updates", "memories", "token-usage", "scheduled-jobs"
    ]);
    expect(listSettingsLiveSections().map((item) => item.id)).toContain("microsoft");
    expect(listSettingsLiveSections().map((item) => item.id)).toContain("github");
    expect(listSettingsLiveSections().map((item) => item.id)).toContain("notion");
  });
});
