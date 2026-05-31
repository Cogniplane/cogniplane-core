import type { NavigationItem } from "@cogniplane/shared-types";

export const ADMIN_LIVE_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "organization", label: "Organization" },
  { id: "privacy", label: "Privacy" },
  { id: "pii", label: "PII activity" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
  { id: "integrations", label: "Integrations" },
  { id: "capabilities", label: "Agent settings" },
  { id: "runtime", label: "Runtime rollout" },
  { id: "users", label: "Users" },
  { id: "sessions", label: "Sessions" },
  { id: "token-usage", label: "Token usage" },
  { id: "message-feedback", label: "Message feedback" }
] as const;

export const ADMIN_NAVIGATION_ITEMS: readonly NavigationItem[] = ADMIN_LIVE_SECTIONS.map((s) => ({
  id: s.id,
  label: s.label
}));
