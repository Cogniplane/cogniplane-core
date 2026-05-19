import type { NavigationItem } from "@cogniplane/shared-types";

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
};

const CORE_LIVE_SECTIONS: readonly SettingsLiveSection[] = [
  { id: "overview", label: "Overview", kind: "always", title: "User preferences", subtitle: "Keep recurring work and personal agent defaults in one place." },
  { id: "github", label: "GitHub", kind: "integration", subtitle: "Connect repositories for the agent to work against." },
  { id: "notion", label: "Notion", kind: "integration", subtitle: "Connect a Notion workspace for the agent to read and update." },
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

export const SETTINGS_PLANNED_SECTIONS = [
  {
    id: "skills",
    label: "Skill selection",
    description: "Pick personal default skills without stepping outside the admin-managed envelope."
  },
  {
    id: "mcp",
    label: "MCP selection",
    description: "Choose from approved MCP surfaces when user-level routing becomes available."
  },
  {
    id: "model",
    label: "Model override",
    description: "Store user-level model preferences while preserving platform guardrails and auditability."
  }
] as const;

export function listSettingsNavigationItems(): readonly NavigationItem[] {
  return [
    ...listSettingsLiveSections().map((s) => ({ id: s.id, label: s.label, tone: "live" as const })),
    ...SETTINGS_PLANNED_SECTIONS.map((s) => ({ id: s.id, label: s.label, tone: "planned" as const }))
  ];
}
