import type { ComponentType } from "react";

import { GithubAccountRow, GithubSettingsDetail } from "../../components/github-settings";
import { JiraAccountRow, JiraSettingsDetail } from "../../components/jira-settings";
import { NotionAccountRow, NotionSettingsDetail } from "../../components/notion-settings";
import type { SettingsLiveSection } from "./settings-sections";

// Components of the core services. They are not in `settings-sections.ts`
// because quick jump and the overlay bootstrap load that file on every page.
// Only the settings pages import this file.
//
// An overlay cannot register a core id (`registerSettingsSection` ignores
// it), so the lookup by id cannot select overlay components for a core
// service.
const CORE_SECTION_COMPONENTS: ReadonlyMap<string, { readonly accountRow: ComponentType; readonly detail: ComponentType }> = new Map([
  ["github", { accountRow: GithubAccountRow, detail: GithubSettingsDetail }],
  ["notion", { accountRow: NotionAccountRow, detail: NotionSettingsDetail }],
  ["jira", { accountRow: JiraAccountRow, detail: JiraSettingsDetail }]
]);

// Returns the section with the components of a core service filled in.
export function withSectionComponents(section: SettingsLiveSection): SettingsLiveSection {
  const core = CORE_SECTION_COMPONENTS.get(section.id);
  return core ? { ...section, ...core } : section;
}
