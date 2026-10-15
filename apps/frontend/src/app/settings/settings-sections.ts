import type { NavigationItem } from "@cogniplane/shared-types";
import type { ComponentType } from "react";

// `kind: "integration"` rows render only when the matching integration is
// enabled for the tenant (driven by /me/integrations-availability). The
// section `id` must match the integration descriptor `id` registered in the
// backend's integration registry.
//
// Private overlays (e.g. SharePoint) extend this list by calling
// `registerSettingsSection(...)` from their frontend bootstrap. That keeps
// the core sections list integration-agnostic and lets the OSS subset ship
// without dead `microsoft` entries.
export type SettingsLiveSection = {
  readonly id: string;
  readonly label: string;
  readonly kind: "always" | "integration";
  readonly title?: string;
  readonly subtitle?: string;
  readonly accountRow?: ComponentType;
};

const CORE_LIVE_SECTIONS: readonly SettingsLiveSection[] = [
  { id: "connections", label: "Connected accounts", kind: "always", subtitle: "Connect your accounts to let the agent work with services your organization has enabled." },
  { id: "capabilities", label: "Skills & connections", kind: "always", subtitle: "Manage private skills and choose defaults for your chats in this organization." },
  { id: "skill-updates", label: "Skill updates", kind: "always", subtitle: "Review decisions and releases for skills you submitted." },
  { id: "memories", label: "Memories", kind: "always", subtitle: "Review, edit and delete what the agent has saved about you." },
  { id: "github", label: "GitHub", kind: "integration", subtitle: "Connect repositories for the agent to work against." },
  { id: "notion", label: "Notion", kind: "integration", subtitle: "Connect a Notion workspace for the agent to read and update." },
  { id: "jira", label: "Jira", kind: "integration", subtitle: "Connect a Jira Cloud site for the agent to read." },
  { id: "token-usage", label: "Token usage", kind: "always", subtitle: "Your consumption across sessions." },
  { id: "scheduled-jobs", label: "Scheduled jobs", kind: "always", subtitle: "Recurring agent tasks run on your behalf." }
];

const overlaySections: SettingsLiveSection[] = [];

export function registerSettingsSection(section: SettingsLiveSection): void {
  if (overlaySections.some((s) => s.id === section.id)) return;
  if (CORE_LIVE_SECTIONS.some((s) => s.id === section.id)) return;
  overlaySections.push(section);
}

export function listSettingsLiveSections(): readonly SettingsLiveSection[] {
  return [...CORE_LIVE_SECTIONS, ...overlaySections];
}

export function listSettingsNavigationItems(): readonly NavigationItem[] {
  return listSettingsLiveSections()
    .filter((section) => section.kind !== "integration")
    .map((section) => ({ id: section.id, label: section.label }));
}
