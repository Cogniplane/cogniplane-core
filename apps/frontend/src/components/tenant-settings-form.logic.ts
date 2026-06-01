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
  runtimeProvider: "codex" | "claude-code";
  enabledRuntimeProviders: Array<"codex" | "claude-code">;
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
    runtimeProvider: settings.runtimeProvider ?? "codex",
    enabledRuntimeProviders: settings.enabledRuntimeProviders?.length
      ? settings.enabledRuntimeProviders
      : [settings.runtimeProvider ?? "codex"],
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

/**
 * Compute the next state when the user toggles a runtime provider checkbox.
 * Keeps the default provider valid by falling back to the first remaining
 * enabled provider when the previous default is unchecked.
 */
export function toggleRuntimeProviderInDraft(
  current: FormDraft,
  provider: "codex" | "claude-code",
  enabled: boolean
): FormDraft {
  const nextEnabled = enabled
    ? [...current.enabledRuntimeProviders, provider]
    : current.enabledRuntimeProviders.filter((entry) => entry !== provider);
  const deduped = Array.from(new Set(nextEnabled));
  return {
    ...current,
    enabledRuntimeProviders: deduped,
    runtimeProvider: deduped.includes(current.runtimeProvider)
      ? current.runtimeProvider
      : (deduped[0] ?? current.runtimeProvider)
  };
}

/**
 * Order the enabled runtime providers so the chosen default sits at index 0.
 * The backend reads index 0 as the default; the form has an explicit default
 * select but persists it as ordering.
 */
export function orderProvidersWithDefaultFirst(
  enabled: Array<"codex" | "claude-code">,
  preferredDefault: "codex" | "claude-code"
): Array<"codex" | "claude-code"> {
  if (enabled.length === 0) return enabled;
  const defaultProvider = enabled.includes(preferredDefault) ? preferredDefault : enabled[0]!;
  return [defaultProvider, ...enabled.filter((entry) => entry !== defaultProvider)];
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
