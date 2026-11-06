import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { withSectionComponents } from "./settings-section-components";
import { listSettingsLiveSections, listSettingsNavigationItems, registerSettingsSection } from "./settings-sections";

describe("settings navigation", () => {
  it("keeps provider routes registered under one Connected accounts navigation item", () => {
    registerSettingsSection({ id: "example-connector", label: "Example", kind: "integration" });

    // "security" is a local-account section: useEnabledSettingsSections hides
    // it for members of a WorkOS tenant.
    expect(listSettingsNavigationItems().map((item) => item.id)).toEqual([
      "connections", "capabilities", "skill-updates", "memories", "security", "token-usage", "scheduled-jobs"
    ]);
    expect(listSettingsLiveSections().map((item) => item.id)).toContain("example-connector");
    expect(listSettingsLiveSections().map((item) => item.id)).toContain("github");
    expect(listSettingsLiveSections().map((item) => item.id)).toContain("notion");
  });

  it("gives each core service a detail page and an account row that an overlay cannot replace", () => {
    const replacement = () => null;
    registerSettingsSection({ id: "github", label: "Other", kind: "integration", detail: replacement, accountRow: replacement });

    for (const id of ["github", "notion", "jira"]) {
      const matches = listSettingsLiveSections().filter((item) => item.id === id);
      expect(matches).toHaveLength(1);
      expect(withSectionComponents(matches[0]).detail).toBeTypeOf("function");
      expect(withSectionComponents(matches[0]).accountRow).toBeTypeOf("function");
      expect(withSectionComponents(matches[0]).detail).not.toBe(replacement);
      expect(withSectionComponents(matches[0]).accountRow).not.toBe(replacement);
    }
  });

  it("uses the components that an overlay registers for its own section", () => {
    const detail = () => null;
    const accountRow = () => null;
    registerSettingsSection({ id: "example-with-components", label: "Example", kind: "integration", detail, accountRow });

    const section = listSettingsLiveSections().find((item) => item.id === "example-with-components");
    expect(section && withSectionComponents(section).detail).toBe(detail);
    expect(section && withSectionComponents(section).accountRow).toBe(accountRow);
  });

  it("keeps the service components out of the list that every page loads", () => {
    // Quick jump and the overlay bootstrap import settings-sections.ts on
    // every page. A static import of a service component here would add the
    // settings code to each page.
    const source = readFileSync(new URL("./settings-sections.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*components\//);
  });
});
