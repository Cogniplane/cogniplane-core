import type {
  AdminModelCatalogResponse,
  ApprovalPolicy,
  GranularApprovalPolicy,
  PolicyEnforcementMode,
  TenantSettings,
  WebSearchMode
} from "@cogniplane/shared-types";
import { isModelEnabled } from "@cogniplane/shared-types";
// Loads a public suffix list, so it is a separate entry point of the package.
import {
  normalizeSandboxEgressDomains,
  parseSandboxEgressDomain,
  SANDBOX_EGRESS_DOMAINS_MAX
} from "@cogniplane/shared-types/sandbox-egress";

export function modelAvailabilityWarning(
  modelId: string,
  catalog: AdminModelCatalogResponse,
  settings: Pick<TenantSettings, "enabledProviders" | "enabledModelIds">
): string | null {
  const model = catalog.models.find((entry) => entry.id === modelId);
  if (!model) {
    return "Your selected chat model is no longer available. Choose another model in chat.";
  }
  if (!isModelEnabled(model, settings)) {
    return `${model.displayName} is disabled for this organization. Choose another model in chat or enable it in Models.`;
  }

  // /admin/models always returns every provider, so a miss here is not a state
  // worth a message of its own — treat it as "nothing to warn about".
  const provider = catalog.providers.find((entry) => entry.id === model.provider);
  if (!provider || provider.keySource !== "none") return null;
  return `No ${provider.label} API key is configured for your selected chat model, ${model.displayName}. Add one in Models or choose another model in chat.`;
}

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
  autoApproveReadOnlyTools: boolean;
  policyEnforcementMode: PolicyEnforcementMode;
  developerInstructions: string;
  enabledToolIds: string[];
  enabledMcpServerIds: string[];
  /**
   * The approved sandbox hosts as the administrator types them: one per line.
   * The draft keeps the text, so that a half-typed line is not rewritten under
   * the cursor. parseSandboxEgressText turns it into the list that is saved.
   */
  sandboxEgressText: string;
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
    autoApproveReadOnlyTools: settings.autoApproveReadOnlyTools,
    policyEnforcementMode: settings.policyEnforcementMode,
    developerInstructions: settings.developerInstructions ?? "",
    enabledToolIds: [...settings.enabledToolIds],
    enabledMcpServerIds: [...settings.enabledMcpServerIds],
    sandboxEgressText: [...settings.approvedSandboxEgressDomains].sort().join("\n")
  };
}

export type SandboxEgressLineError = {
  /** Line of the text, counted from 1. */
  line: number;
  entry: string;
  message: string;
};

export type ParsedSandboxEgress = {
  /** The hosts that pass the check, sorted and without duplicates. This is what is saved. */
  domains: string[];
  errors: SandboxEgressLineError[];
  /** More hosts than one organization can approve. */
  tooMany: boolean;
};

/**
 * Reads the approved-host text: one host per line, and commas also separate.
 * Spaces around a host and upper case are fixed here, as a paste often has
 * them. Everything else is checked by the rules that the server applies, so
 * that a host is refused here before the server refuses it. The server stays
 * the authority.
 */
export function parseSandboxEgressText(text: string): ParsedSandboxEgress {
  const hosts: string[] = [];
  const errors: SandboxEgressLineError[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const piece of line.split(",")) {
      const entry = piece.trim();
      if (entry === "") continue;
      const result = parseSandboxEgressDomain(entry.toLowerCase());
      if (result.ok) hosts.push(result.value.domain);
      else errors.push({ line: index + 1, entry, message: result.message });
    }
  });
  const domains = normalizeSandboxEgressDomains(hosts);
  return { domains, errors, tooMany: domains.length > SANDBOX_EGRESS_DOMAINS_MAX };
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
