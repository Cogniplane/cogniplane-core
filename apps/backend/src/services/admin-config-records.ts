import type {
  GranularApprovalPolicy,
  ApprovalPolicy,
  ApprovalReviewer,
  RuntimeProvider,
} from "@cogniplane/shared-types";

export type {
  GranularApprovalPolicy,
  ApprovalPolicy,
  ApprovalReviewer,
  RuntimeProvider,
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
  // Tool IDs declared by the active revision's metadata as the tools this
  // skill is meant to be invoked through. Used by the activation tracker to
  // attribute tool calls back to a skill (Tier 1, weak-but-useful signal).
  // Optional so existing test fixtures and partial AdminSkillRecord
  // constructions don't have to be exhaustively updated.
  associatedToolIds?: string[];
  // True when this skill row is owned by `tenant_id = 'system'` and the
  // requesting tenant is not `system`. Inherited skills are read-only from
  // a tenant's perspective: tenants must use the import flows (zip / github /
  // inline paste) to create their own copy before they can edit it.
  isInherited: boolean;
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
};

export type ActiveRuntimeSkillReference = {
  sessionId: string;
  skillId: string;
  revisionId: number | null;
  bundleHash: string | null;
};

export type AdminMcpServerRecord = {
  serverId: string;
  serverName: string;
  description: string | null;
  transportKind: "http";
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
  headersAllowlist: string[];
  version: number;
  configHash: string;
  enabled: boolean;
  isPublished: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
};

import type { TenantSettingsRecord } from "./tenant-settings-store.js";

export function tenantSettingsToRuntimePolicy(settings: TenantSettingsRecord): ResolvedRuntimePolicy {
  return {
    id: `tenant-settings:${settings.tenantId}`,
    label: "Tenant Settings",
    description: null,
    runtimeProvider: settings.runtimeProvider,
    approvalPolicy: settings.approvalPolicy,
    approvalReviewer: settings.approvalReviewer,
    sandboxMode: "workspace-write",
    networkMode: "restricted",
    allowCommandExecution: settings.allowCommandExecution,
    allowUserTokenForwarding: settings.allowUserTokenForwarding,
    autoApproveReadOnlyTools: settings.autoApproveReadOnlyTools,
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
 * Reverse of `tenantSettingsToRuntimePolicy` for the JSONB blob round-tripped
 * through `tool_execution_contexts.metadata.runtimePolicy`. Used by the MCP
 * gateway to enforce the per-turn snapshot of the tenant's runtime policy.
 *
 * Field-level coercion mirrors the original DB → object decoders elsewhere
 * (e.g. `mapJudgmentRow`): each field is coerced to its declared type with
 * a safe fallback so a single bad row can't crash an entire turn. Unknown
 * enum values land on the conservative default (`approvalReviewer: "user"`,
 * `runtimeProvider: "codex"`, `approvalPolicy: "never"`).
 *
 * `sandboxMode` and `networkMode` are single-valued literal types on
 * `ResolvedRuntimePolicy` today (`"workspace-write"` and `"restricted"`).
 * They're emitted by `tenantSettingsToRuntimePolicy` and never read back
 * differently. When the type is widened to allow more values, both this
 * parser and `tenantSettingsToRuntimePolicy` need to thread the actual
 * setting through. Keep the literals here as the single source of fallback.
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
    runtimeProvider: (profile.runtimeProvider === "claude-code" ? "claude-code" : "codex") as RuntimeProvider,
    approvalPolicy: parseSnapshotApprovalPolicy(profile.approvalPolicy),
    approvalReviewer: (profile.approvalReviewer === "guardian_subagent" ? "guardian_subagent" : "user") as ApprovalReviewer,
    sandboxMode: "workspace-write",
    networkMode: "restricted",
    allowCommandExecution: Boolean(profile.allowCommandExecution),
    allowUserTokenForwarding: Boolean(profile.allowUserTokenForwarding),
    autoApproveReadOnlyTools: Boolean(profile.autoApproveReadOnlyTools),
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
  transportKind: "http";
  headersAllowlist: string[];
  version: number;
  hash: string;
};

export type ResolvedRuntimePolicy = {
  id: string;
  label: string;
  description: string | null;
  runtimeProvider: RuntimeProvider;
  approvalPolicy: ApprovalPolicy;
  approvalReviewer: ApprovalReviewer;
  sandboxMode: "workspace-write";
  networkMode: "restricted";
  allowCommandExecution: boolean;
  allowUserTokenForwarding: boolean;
  autoApproveReadOnlyTools: boolean;
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
    }>;
  };
};

export type SkillRevisionCleanupReport = {
  dryRun: boolean;
  deletedRevisionIds: number[];
  deletedBundleStorageUris: string[];
  keptRevisionDecisions: Array<{ skillRevisionId: number; reason: string }>;
  failures: Array<{ skillRevisionId: number; reason: string }>;
};
