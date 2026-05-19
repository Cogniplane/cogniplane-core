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
  { id: "skill-judge", label: "Skill judge" },
  { id: "runtime", label: "Runtime rollout" },
  { id: "users", label: "Users" },
  { id: "sessions", label: "Sessions" },
  { id: "token-usage", label: "Token usage" },
  { id: "message-feedback", label: "Message feedback" }
] as const;

export const ADMIN_PLANNED_SECTIONS = [
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Operational overview, queue health, adoption metrics, and runtime saturation."
  },
  {
    id: "history",
    label: "History & tracing",
    description: "Conversation timelines, tool spans, approvals, replay, and audit visibility."
  },
  {
    id: "compliance",
    label: "Compliance & audit",
    description:
      "Signed evidence packs (EU AI Act, SR 11-7, HIPAA, SOC 2, ISO 42001), per-artifact AI-BOM provenance, and a dedicated auditor workbench."
  },
  {
    id: "security-policy",
    label: "Security & policy",
    description:
      "Policy-as-code in customer git, prompt-injection defense on tool outputs, and scoped non-human agent identities (Okta NHI, CyberArk)."
  },
  {
    id: "handoffs",
    label: "Cross-department handoffs",
    description:
      "Signed handoff artifacts between teams with capability-matched queues, receiving-side approvals, and policy re-evaluation at each boundary."
  },
  {
    id: "costs",
    label: "Cost & shadow AI",
    description:
      "Spend policy, per-department token attribution, chargeback exports, and shadow-AI discovery from DNS/SSO logs."
  },
  {
    id: "operations",
    label: "HITL ops & evals",
    description:
      "Approval delegation, SLA escalation, mobile approvals, plus golden-set evals tied to rollout safety for non-deterministic outputs."
  }
] as const;

export const ADMIN_NAVIGATION_ITEMS: readonly NavigationItem[] = [
  ...ADMIN_LIVE_SECTIONS.map((s) => ({ id: s.id, label: s.label, tone: "live" as const })),
  ...ADMIN_PLANNED_SECTIONS.map((s) => ({ id: s.id, label: s.label, tone: "planned" as const }))
];
