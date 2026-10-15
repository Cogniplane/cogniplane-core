import type { NavigationItem } from "@cogniplane/shared-types";

export const ADMIN_LIVE_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models", group: "Setup" },
  { id: "connections", label: "Connections", group: "Setup" },
  { id: "skills", label: "Skills", group: "Setup" },
  { id: "capabilities", label: "Agent behavior", group: "Setup" },
  { id: "users", label: "People", group: "Governance" },
  { id: "project-owners", label: "Project owners", group: "Governance" },
  { id: "policy", label: "Policies", group: "Governance" },
  { id: "privacy", label: "Privacy", group: "Governance" },
  { id: "history", label: "History", group: "Activity" },
  { id: "sessions", label: "Sessions", group: "Activity" },
  { id: "token-usage", label: "Usage", group: "Activity" },
  { id: "message-feedback", label: "Feedback", group: "Activity" },
  { id: "runtime", label: "Runtime diagnostics", group: "Advanced" }
] as const;

export type AdminSectionId = (typeof ADMIN_LIVE_SECTIONS)[number]["id"];

export const ADMIN_NAVIGATION_ITEMS: readonly (NavigationItem & { group?: string })[] = ADMIN_LIVE_SECTIONS;

// Older URLs that still open a page. Each one belongs to the section that now owns it.
const ADMIN_SECTION_ALIASES: Record<string, AdminSectionId> = {
  mcp: "connections",
  integrations: "connections",
  pii: "privacy",
  organization: "overview"
};

/** The nav section for an admin path. Matches whole path segments only. */
export function adminSectionForPath(pathname: string): AdminSectionId {
  const segment = /^\/admin\/([^/?#]+)/.exec(pathname)?.[1];
  if (!segment) return "overview";
  const section = ADMIN_LIVE_SECTIONS.find((item) => item.id === segment);
  return section?.id ?? ADMIN_SECTION_ALIASES[segment] ?? "overview";
}
