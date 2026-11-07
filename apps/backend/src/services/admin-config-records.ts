import type {
  GranularApprovalPolicy,
  ApprovalPolicy,
  ApprovalReviewer,
  PolicyEnforcementMode,
  WebSearchMode,
} from "@cogniplane/shared-types";
import type { McpUpstreamAuth } from "../lib/mcp-upstream-client.js";

export type {
  GranularApprovalPolicy,
  ApprovalPolicy,
  ApprovalReviewer,
  WebSearchMode,
};

export type AdminSkillRecord = {
  skillId: string;
  skillName: string;
  description: string | null;
  instructions: string;
  version: number;
  contentHash: string;
  enabled: boolean;
  isPublished: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  activeRevisionId: number | null;
  activeSourceType: string | null;
  activeBundleName: string | null;
  activeBundleStorageUri: string | null;
  activeBundleHash: string | null;
  activeValidationStatus: string | null;
  activeReviewStatus: string | null;
  // Tool IDs that the active revision declares for this skill. The activation
  // tracker uses them to credit tool calls to the skill (Tier 1, a weak signal).
  // Optional, so partial records and test fixtures need not set it.
  associatedToolIds?: string[];
  // True when the row belongs to the `system` tenant and the requesting tenant
  // is not `system`. Inherited skills are read-only for tenants. A tenant must
  // import its own copy (zip, GitHub, or inline paste) before it can edit it.
  isInherited: boolean;
  pendingRevisionCount?: number;
};

export type AdminSkillRevisionRecord = {
  skillRevisionId: number;
  skillId: string;
  revisionNumber: number;
  sourceType: string;
  sourceLabel: string | null;
  bundleName: string | null;
  bundleStorageUri: string | null;
  bundleHash: string;
  validationStatus: string;
  validationMessages: Array<Record<string, unknown>>;
  reviewStatus: string;
  reviewNotes: string | null;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  activatedAt: string | null;
};

export type ImportedSkillBundleRecord = {
  skill: AdminSkillRecord;
  revision: AdminSkillRevisionRecord;
};

export type ActivatedSkillRevisionRecord = {
  skill: AdminSkillRecord;
  revision: AdminSkillRevisionRecord;
  previousActiveRevisionId: number | null;
  previousActiveRevisionNumber: number | null;
};

export type ActiveRuntimeSkillReference = {
  sessionId: string;
  skillId: string;
  revisionId: number | null;
  bundleHash: string | null;
};

export type AdminMcpServerRecord = {
  serverId: string;
  ownerTenantId?: string;
  serverName: string;
  description: string | null;
  transportKind: "http";
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
  upstreamAuthType: "none" | "bearer" | "header" | "query";
  upstreamAuthName: string | null;
  upstreamAuthConfigured: boolean;
  credentialScope: "organization" | "personal";
  credentialBindingId: string;
  version: number;
  configHash: string;
  enabled: boolean;
  isPublished: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeMcpServerRecord = AdminMcpServerRecord & {
  upstreamAuth: McpUpstreamAuth | null;
};

export type TenantMemberRecord = {
  userId: string;
  tenantId: string;
  email: string | null;
  displayName: string | null;
  role: "owner" | "admin" | "member";
  isBetaTester: boolean;
  createdAt: string;
  updatedAt: string;
  /** Local accounts only: pending_setup, active, disabled. Null for WorkOS members. */
  accountStatus?: "pending_setup" | "active" | "disabled" | "removed" | null;
  /** Local accounts only: a second factor (authenticator app or passkey) is set up. */
  mfaEnabled?: boolean;
  /** Local accounts only. */
  passkeyCount?: number;
  /** Local accounts only: the latest email that carried a link, or null. */
  linkEmail?: {
    purpose: "account_setup" | "password_reset";
    status: "queued" | "sending" | "sent" | "failed" | "expired";
    updatedAt: string;
    error: string | null;
  } | null;
};

import type { TenantSettingsRecord } from "./tenant-settings-store.js";

export function tenantSettingsToRuntimePolicy(settings: TenantSettingsRecord): ResolvedRuntimePolicy {
  return {
    id: `tenant-settings:${settings.tenantId}`,
    label: "Tenant Settings",
    description: null,
    webSearchMode: settings.webSearchMode,
    approvalPolicy: settings.approvalPolicy,
    approvalReviewer: settings.approvalReviewer,
    sandboxMode: "workspace-write",
    sandboxEgressDomains: [...settings.approvedSandboxEgressDomains],
    allowCommandExecution: settings.allowCommandExecution,
    autoApproveReadOnlyTools: settings.autoApproveReadOnlyTools,
    policyEnforcementMode: settings.policyEnforcementMode,
    developerInstructions: settings.developerInstructions,
    enabledToolIds: settings.enabledToolIds,
    enabledMcpServers: settings.enabledMcpServerIds,
    version: settings.version,
    hash: settings.configHash
  };
}

function parseSnapshotApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === "never" || value === "on-request") return value;
  if (typeof value === "object" && value !== null && "granular" in value) {
    return value as ApprovalPolicy;
  }
  return "never";
}

/**
 * Reverses `tenantSettingsToRuntimePolicy` for the JSONB snapshot stored in
 * `tool_execution_contexts.metadata.runtimePolicy`. The MCP gateway uses it to
 * enforce the per-turn snapshot of the tenant's runtime policy.
 *
 * The parser coerces each field to its declared type with a safe fallback, so
 * one bad row cannot crash a turn. Unknown enum values use the conservative defaults
 * (`approvalReviewer: "user"`, `approvalPolicy: "never"`).
 *
 * `sandboxMode` has one value today, `"workspace-write"`. When the type allows
 * more values, this parser and `tenantSettingsToRuntimePolicy` must both pass
 * the real setting through. Keep the literal here as the fallback.
 *
 * An empty `sandboxEgressDomains` is the strictest policy. A snapshot that
 * predates the field, or one that is malformed, gives the sandbox no network.
 */
export function parseRuntimePolicySnapshot(
  value: unknown,
  context: { toolContextId: string }
): ResolvedRuntimePolicy {
  if (!value || typeof value !== "object") {
    throw new Error(`Runtime policy snapshot missing for tool context ${context.toolContextId}.`);
  }

  const profile = value as Record<string, unknown>;
  const enabledToolIds = Array.isArray(profile.enabledToolIds)
    ? profile.enabledToolIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const enabledMcpServers = Array.isArray(profile.enabledMcpServers)
    ? profile.enabledMcpServers.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    id: String(profile.id),
    label: String(profile.label ?? profile.id),
    description: profile.description ? String(profile.description) : null,
    webSearchMode: (profile.webSearchMode === "cached" || profile.webSearchMode === "live"
      ? profile.webSearchMode
      : "disabled") as WebSearchMode,
    approvalPolicy: parseSnapshotApprovalPolicy(profile.approvalPolicy),
    approvalReviewer: (profile.approvalReviewer === "guardian_subagent" ? "guardian_subagent" : "user") as ApprovalReviewer,
    sandboxMode: "workspace-write",
    sandboxEgressDomains: Array.isArray(profile.sandboxEgressDomains)
      ? profile.sandboxEgressDomains.filter((entry): entry is string => typeof entry === "string")
      : [],
    allowCommandExecution: Boolean(profile.allowCommandExecution),
    autoApproveReadOnlyTools: Boolean(profile.autoApproveReadOnlyTools),
    // A missing or old snapshot defaults to "monitor", so it never gates
    // actions unexpectedly.
    policyEnforcementMode: profile.policyEnforcementMode === "enforce" ? "enforce" : "monitor",
    developerInstructions: profile.developerInstructions ? String(profile.developerInstructions) : null,
    enabledToolIds,
    enabledMcpServers,
    version: Number(profile.version ?? 1),
    hash: String(profile.hash ?? "")
  };
}

export type RuntimeSkillDefinition = {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  version: number;
  hash: string;
  revisionId: number | null;
  bundleHash: string | null;
  sourceType: string | null;
  bundleName: string | null;
  bundleStorageUri: string | null;
  validationStatus: string | null;
  reviewStatus: string | null;
  associatedToolIds?: string[];
};

export type McpServerRegistration = {
  id: string;
  description: string;
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
  upstreamAuth?: McpUpstreamAuth | null;
  transportKind: "http";
  version: number;
  hash: string;
  credentialScope?: "organization" | "personal";
  credentialBindingId?: string;
  credentialVersion?: number | null;
};

export type ResolvedRuntimePolicy = {
  id: string;
  label: string;
  description: string | null;
  webSearchMode: WebSearchMode;
  approvalPolicy: ApprovalPolicy;
  approvalReviewer: ApprovalReviewer;
  sandboxMode: "workspace-write";
  /**
   * Hosts that the sandbox may reach, from the tenant's approved list. Empty
   * means no network. The sandbox network policy and the recorded network mode
   * both come from this list, so they cannot disagree.
   */
  sandboxEgressDomains: string[];
  allowCommandExecution: boolean;
  autoApproveReadOnlyTools: boolean;
  /**
   * Tenant-level Policy Center switch. "monitor": rules are evaluated and
   * decisions recorded but nothing is gated; "enforce": matching block /
   * require_approval rules gate the action. Snapshotted here so the MCP gateway
   * reads it from the tool-execution context with no hot-path DB call.
   */
  policyEnforcementMode: PolicyEnforcementMode;
  developerInstructions: string | null;
  enabledToolIds: string[];
  enabledMcpServers: string[];
  version: number;
  hash: string;
};

export type RuntimeConfigBundle = {
  runtimePolicy: ResolvedRuntimePolicy;
  skills: RuntimeSkillDefinition[];
  mcpServers: McpServerRegistration[];
  hash: string;
  sources: {
    runtimePolicy: {
      id: string;
      version: number;
      hash: string;
    };
    skills: Array<{
      id: string;
      version: number;
      hash: string;
      revisionId: number | null;
      bundleHash: string | null;
    }>;
    mcpServers: Array<{
      id: string;
      version: number;
      hash: string;
      credentialVersion?: number | null;
    }>;
    integrationToolIds?: string[];
    integrationAccounts?: Record<string, string>;
  };
};

export type SkillRevisionCleanupReport = {
  dryRun: boolean;
  deletedRevisionIds: number[];
  deletedBundleStorageUris: string[];
  keptRevisionDecisions: Array<{ skillRevisionId: number; reason: string }>;
  failures: Array<{ skillRevisionId: number; reason: string }>;
};
