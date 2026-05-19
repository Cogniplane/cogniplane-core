// Primitive type definitions shared across the API surface. Lives in its own
// file (not in index.ts) so the schema modules can import these without
// re-entering the index barrel — that re-entry caused a circular-init crash
// at runtime when the schemas tried to read `EFFORT_LEVELS` from a half-loaded
// index.

export type GranularApprovalPolicy = {
  granular: {
    sandbox_approval: boolean;
    mcp_elicitations: boolean;
    rules: boolean;
    request_permissions?: boolean;
    skill_approval?: boolean;
  };
};

export type ApprovalPolicy = "never" | "on-request" | GranularApprovalPolicy;

export type ApprovalReviewer = "user" | "guardian_subagent";

export type RuntimeProvider = "codex" | "claude-code";

export const EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
