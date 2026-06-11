import { type Pool, withTenantScope } from "../lib/db.js";
import { AdminConfigError } from "./admin-config-error.js";
import { computeConfigHash } from "../lib/crypto-utils.js";

import type { PolicyEnforcementMode, WebSearchMode } from "@cogniplane/shared-types";

import type { ApprovalPolicy, ApprovalReviewer, RuntimeProvider } from "./admin-config-records.js";
import { parseApprovalPolicy, parseApprovalReviewer } from "./admin-config-store-mappers.js";
import { isoTimestamp } from "../lib/db-mappers.js";

export const DEFAULT_TENANT_TOOL_IDS = [
  "managed-session-context",
  "session_context",
  "list_artifacts",
  "read_text_artifact",
  "read_skill_corpus",
  "write_artifact"
];

export const DEFAULT_TENANT_MCP_SERVER_IDS = ["managed-session-context"];

function normalizeRuntimeProviders(value: unknown): RuntimeProvider[] {
  const raw = Array.isArray(value) ? value : [];
  const providers: RuntimeProvider[] = [];
  for (const entry of raw) {
    const provider = entry === "claude-code" ? "claude-code" : entry === "codex" ? "codex" : null;
    if (provider && !providers.includes(provider)) {
      providers.push(provider);
    }
  }
  return providers;
}

export type TenantSettingsRecord = {
  tenantId: string;
  /** Default runtime provider — derived from `enabledRuntimeProviders[0]`. */
  runtimeProvider: RuntimeProvider;
  /** Ordered list of enabled providers; index 0 is the default. */
  enabledRuntimeProviders: RuntimeProvider[];
  showEffortSelector: boolean;
  webSearchMode: WebSearchMode;
  approvalPolicy: ApprovalPolicy;
  approvalReviewer: ApprovalReviewer;
  allowCommandExecution: boolean;
  allowUserTokenForwarding: boolean;
  autoApproveReadOnlyTools: boolean;
  /** Tenant-level Policy Center switch (monitor → enforce). */
  policyEnforcementMode: PolicyEnforcementMode;
  developerInstructions: string | null;
  enabledToolIds: string[];
  enabledMcpServerIds: string[];
  version: number;
  configHash: string;
  updatedAt: string;
};

function parsePolicyEnforcementMode(value: unknown): PolicyEnforcementMode {
  return value === "enforce" ? "enforce" : "monitor";
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseWebSearchMode(value: unknown): WebSearchMode {
  return value === "cached" || value === "live" ? value : "disabled";
}

function mapRow(row: Record<string, unknown>): TenantSettingsRecord {
  const enabledRuntimeProviders = normalizeRuntimeProviders(row.enabled_runtime_providers);
  const resolvedProviders =
    enabledRuntimeProviders.length > 0 ? enabledRuntimeProviders : (["codex"] as RuntimeProvider[]);
  return {
    tenantId: String(row.tenant_id),
    runtimeProvider: resolvedProviders[0]!,
    enabledRuntimeProviders: resolvedProviders,
    showEffortSelector: Boolean(row.show_effort_selector),
    webSearchMode: parseWebSearchMode(row.web_search_mode),
    approvalPolicy: parseApprovalPolicy(row.approval_policy),
    approvalReviewer: parseApprovalReviewer(row.approval_reviewer),
    allowCommandExecution: Boolean(row.allow_command_execution),
    allowUserTokenForwarding: Boolean(row.allow_user_token_forwarding),
    autoApproveReadOnlyTools: Boolean(row.auto_approve_read_only_tools),
    policyEnforcementMode: parsePolicyEnforcementMode(row.policy_enforcement_mode),
    developerInstructions: row.developer_instructions ? String(row.developer_instructions) : null,
    enabledToolIds: toStringArray(row.enabled_tool_ids),
    enabledMcpServerIds: toStringArray(row.enabled_mcp_server_ids),
    version: Number(row.version),
    configHash: String(row.config_hash),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

function serializeApprovalPolicy(policy: ApprovalPolicy): string {
  if (typeof policy === "string") return policy;
  return JSON.stringify(policy);
}

export type TenantSettingsInput = {
  enabledRuntimeProviders?: RuntimeProvider[];
  showEffortSelector?: boolean;
  webSearchMode?: WebSearchMode;
  approvalPolicy?: ApprovalPolicy;
  approvalReviewer?: ApprovalReviewer;
  allowCommandExecution?: boolean;
  allowUserTokenForwarding?: boolean;
  autoApproveReadOnlyTools?: boolean;
  policyEnforcementMode?: PolicyEnforcementMode;
  developerInstructions?: string | null;
  enabledToolIds?: string[];
  enabledMcpServerIds?: string[];
};

function hasOwn(input: TenantSettingsInput, key: keyof TenantSettingsInput): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function buildDefaultTenantSettingsInput(): Required<TenantSettingsInput> {
  return {
    enabledRuntimeProviders: ["codex"],
    showEffortSelector: false,
    webSearchMode: "disabled",
    approvalPolicy: "on-request",
    approvalReviewer: "user",
    allowCommandExecution: false,
    allowUserTokenForwarding: true,
    autoApproveReadOnlyTools: true,
    // Policy Center inert until deliberately armed — rules record decisions but
    // gate nothing until flipped to "enforce".
    policyEnforcementMode: "monitor",
    developerInstructions: null,
    enabledToolIds: [...DEFAULT_TENANT_TOOL_IDS],
    enabledMcpServerIds: [...DEFAULT_TENANT_MCP_SERVER_IDS]
  };
}

export class TenantSettingsStore {
  constructor(private readonly db: Pool) {}

  async get(tenantId: string): Promise<TenantSettingsRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async upsert(tenantId: string, input: TenantSettingsInput): Promise<TenantSettingsRecord> {
    return withTenantScope(this.db, tenantId, async (client) => {
      // Serialize upserts per tenant: the merge below is a read-modify-write,
      // and a row lock alone cannot cover the first-insert race (no row to
      // lock). The advisory lock is transaction-scoped and released on
      // COMMIT/ROLLBACK.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('tenant_settings:' || $1, 0))`,
        [tenantId]
      );
      const existingResult = await client.query(
        `SELECT * FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId]
      );
      const existing = existingResult.rows[0] ? mapRow(existingResult.rows[0]) : null;
      const defaults = buildDefaultTenantSettingsInput();

      const resolvedEnabledRuntimeProviders = hasOwn(input, "enabledRuntimeProviders")
        ? normalizeRuntimeProviders(input.enabledRuntimeProviders ?? defaults.enabledRuntimeProviders)
        : (existing?.enabledRuntimeProviders ?? defaults.enabledRuntimeProviders);
      if (resolvedEnabledRuntimeProviders.length === 0) {
        throw new AdminConfigError("At least one runtime provider must be enabled.");
      }
      const resolvedPolicy = hasOwn(input, "approvalPolicy")
        ? (input.approvalPolicy ?? defaults.approvalPolicy)
        : (existing?.approvalPolicy ?? defaults.approvalPolicy);
      const resolvedShowEffortSelector = hasOwn(input, "showEffortSelector")
        ? (input.showEffortSelector ?? defaults.showEffortSelector)
        : (existing?.showEffortSelector ?? defaults.showEffortSelector);
      const resolvedWebSearchMode = hasOwn(input, "webSearchMode")
        ? (input.webSearchMode ?? defaults.webSearchMode)
        : (existing?.webSearchMode ?? defaults.webSearchMode);
      const resolvedReviewer = hasOwn(input, "approvalReviewer")
        ? (input.approvalReviewer ?? defaults.approvalReviewer)
        : (existing?.approvalReviewer ?? defaults.approvalReviewer);
      const resolvedCommandExec = hasOwn(input, "allowCommandExecution")
        ? (input.allowCommandExecution ?? defaults.allowCommandExecution)
        : (existing?.allowCommandExecution ?? defaults.allowCommandExecution);
      const resolvedTokenFwd = hasOwn(input, "allowUserTokenForwarding")
        ? (input.allowUserTokenForwarding ?? defaults.allowUserTokenForwarding)
        : (existing?.allowUserTokenForwarding ?? defaults.allowUserTokenForwarding);
      const resolvedReadOnly = hasOwn(input, "autoApproveReadOnlyTools")
        ? (input.autoApproveReadOnlyTools ?? defaults.autoApproveReadOnlyTools)
        : (existing?.autoApproveReadOnlyTools ?? defaults.autoApproveReadOnlyTools);
      const resolvedPolicyEnforcementMode = hasOwn(input, "policyEnforcementMode")
        ? (input.policyEnforcementMode ?? defaults.policyEnforcementMode)
        : (existing?.policyEnforcementMode ?? defaults.policyEnforcementMode);
      const resolvedInstructions = hasOwn(input, "developerInstructions")
        ? (input.developerInstructions ?? defaults.developerInstructions)
        : (existing?.developerInstructions ?? defaults.developerInstructions);
      const resolvedToolIds = hasOwn(input, "enabledToolIds")
        ? (input.enabledToolIds ?? defaults.enabledToolIds)
        : (existing?.enabledToolIds ?? defaults.enabledToolIds);
      const resolvedMcpIds = hasOwn(input, "enabledMcpServerIds")
        ? (input.enabledMcpServerIds ?? defaults.enabledMcpServerIds)
        : (existing?.enabledMcpServerIds ?? defaults.enabledMcpServerIds);

      const configHash = computeConfigHash({
        tenantId,
        enabledRuntimeProviders: resolvedEnabledRuntimeProviders,
        showEffortSelector: resolvedShowEffortSelector,
        webSearchMode: resolvedWebSearchMode,
        approvalPolicy: resolvedPolicy,
        approvalReviewer: resolvedReviewer,
        allowCommandExecution: resolvedCommandExec,
        allowUserTokenForwarding: resolvedTokenFwd,
        autoApproveReadOnlyTools: resolvedReadOnly,
        policyEnforcementMode: resolvedPolicyEnforcementMode,
        developerInstructions: resolvedInstructions,
        enabledToolIds: resolvedToolIds,
        enabledMcpServerIds: resolvedMcpIds
      });

      const result = await client.query(
        `
          INSERT INTO tenant_settings (
            tenant_id,
            enabled_runtime_providers,
            show_effort_selector,
            web_search_mode,
            approval_policy,
            approval_reviewer,
            allow_command_execution,
            allow_user_token_forwarding,
            auto_approve_read_only_tools,
            policy_enforcement_mode,
            developer_instructions,
            enabled_tool_ids,
            enabled_mcp_server_ids,
            version,
            config_hash,
            updated_at
          )
          VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, 1, $14, NOW())
          ON CONFLICT (tenant_id) DO UPDATE SET
            enabled_runtime_providers = EXCLUDED.enabled_runtime_providers,
            show_effort_selector = EXCLUDED.show_effort_selector,
            web_search_mode = EXCLUDED.web_search_mode,
            approval_policy = EXCLUDED.approval_policy,
            approval_reviewer = EXCLUDED.approval_reviewer,
            allow_command_execution = EXCLUDED.allow_command_execution,
            allow_user_token_forwarding = EXCLUDED.allow_user_token_forwarding,
            auto_approve_read_only_tools = EXCLUDED.auto_approve_read_only_tools,
            policy_enforcement_mode = EXCLUDED.policy_enforcement_mode,
            developer_instructions = EXCLUDED.developer_instructions,
            enabled_tool_ids = EXCLUDED.enabled_tool_ids,
            enabled_mcp_server_ids = EXCLUDED.enabled_mcp_server_ids,
            version = tenant_settings.version + 1,
            config_hash = EXCLUDED.config_hash,
            updated_at = NOW()
          RETURNING *
        `,
        [
          tenantId,
          JSON.stringify(resolvedEnabledRuntimeProviders),
          resolvedShowEffortSelector,
          resolvedWebSearchMode,
          serializeApprovalPolicy(resolvedPolicy),
          resolvedReviewer,
          resolvedCommandExec,
          resolvedTokenFwd,
          resolvedReadOnly,
          resolvedPolicyEnforcementMode,
          resolvedInstructions,
          JSON.stringify(resolvedToolIds),
          JSON.stringify(resolvedMcpIds),
          configHash
        ]
      );

      return mapRow(result.rows[0]);
    });
  }
}
