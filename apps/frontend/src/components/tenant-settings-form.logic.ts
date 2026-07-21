import type {
  ApprovalPolicy,
  GranularApprovalPolicy,
  PolicyEnforcementMode,
  TenantSettings,
  WebSearchMode
} from "@cogniplane/shared-types";

export type ApprovalPolicyKind = "never" | "on-request" | "granular";

export type GranularFlags = {
  sandbox_approval: boolean;
  mcp_elicitations: boolean;
  rules: boolean;
  request_permissions: boolean;
  skill_approval: boolean;
};

export type FormDraft = {
  showEffortSelector: boolean;
  webSearchMode: WebSearchMode;
  approvalPolicyKind: ApprovalPolicyKind;
  granularFlags: GranularFlags;
  approvalReviewer: "user" | "guardian_subagent";
  allowCommandExecution: boolean;
  allowUserTokenForwarding: boolean;
  autoApproveReadOnlyTools: boolean;
  policyEnforcementMode: PolicyEnforcementMode;
  developerInstructions: string;
  enabledToolIds: string[];
  enabledMcpServerIds: string[];
};

export const defaultGranularFlags: GranularFlags = {
  sandbox_approval: false,
  mcp_elicitations: false,
  rules: false,
  request_permissions: false,
  skill_approval: false
};

export function toApprovalPolicyKind(policy: ApprovalPolicy): ApprovalPolicyKind {
  if (typeof policy === "object" && "granular" in policy) return "granular";
  return policy;
}

export function toGranularFlags(policy: ApprovalPolicy): GranularFlags {
  if (typeof policy === "object" && "granular" in policy) {
    const g = (policy as GranularApprovalPolicy).granular;
    return {
      sandbox_approval: g.sandbox_approval,
      mcp_elicitations: g.mcp_elicitations,
      rules: g.rules,
      request_permissions: g.request_permissions ?? false,
      skill_approval: g.skill_approval ?? false
    };
  }
  return defaultGranularFlags;
}

export function toApprovalPolicy(kind: ApprovalPolicyKind, flags: GranularFlags): ApprovalPolicy {
  if (kind === "granular") {
    return {
      granular: {
        sandbox_approval: flags.sandbox_approval,
        mcp_elicitations: flags.mcp_elicitations,
        rules: flags.rules,
        request_permissions: flags.request_permissions,
        skill_approval: flags.skill_approval
      }
    };
  }
  return kind;
}

export function buildDraft(settings: TenantSettings): FormDraft {
  return {
    showEffortSelector: settings.showEffortSelector ?? false,
    webSearchMode: settings.webSearchMode ?? "disabled",
    approvalPolicyKind: toApprovalPolicyKind(settings.approvalPolicy),
    granularFlags: toGranularFlags(settings.approvalPolicy),
    approvalReviewer: settings.approvalReviewer,
    allowCommandExecution: settings.allowCommandExecution,
    allowUserTokenForwarding: settings.allowUserTokenForwarding,
    autoApproveReadOnlyTools: settings.autoApproveReadOnlyTools,
    policyEnforcementMode: settings.policyEnforcementMode,
    developerInstructions: settings.developerInstructions ?? "",
    enabledToolIds: [...settings.enabledToolIds],
    enabledMcpServerIds: [...settings.enabledMcpServerIds]
  };
}

/** Toggle a string id in or out of an array. Idempotent. */
export function toggleInArray(values: string[], id: string, enabled: boolean): string[] {
  if (enabled) {
    return values.includes(id) ? values : [...values, id];
  }
  return values.filter((entry) => entry !== id);
}

/** Casual relative-time formatter for the "Updated …" pill. */
export function formatRelativeTime(dateString: string, now: Date = new Date()): string {
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
