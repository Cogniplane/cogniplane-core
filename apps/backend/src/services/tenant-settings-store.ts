import { type Pool, withTenantScope } from "../lib/db.js";
import { computeConfigHash } from "../lib/crypto-utils.js";

import type { EffortLevel, ModelProvider, PolicyEnforcementMode, WebSearchMode } from "@cogniplane/shared-types";
import { EFFORT_LEVELS, MODEL_PROVIDERS } from "@cogniplane/shared-types";

import type { ApprovalPolicy, ApprovalReviewer } from "./admin-config-records.js";
import { parseApprovalPolicy, parseApprovalReviewer } from "./admin-config-store-mappers.js";
import { isoTimestamp } from "../lib/db-mappers.js";

export const DEFAULT_TENANT_TOOL_IDS = [
  "managed-session-context",
  "session_context",
  "list_artifacts",
  "read_text_artifact",
  "read_skill_corpus",
  "write_artifact",
  "memory_search",
  "memory_save",
  "memory_delete"
];

export const DEFAULT_TENANT_MCP_SERVER_IDS = ["managed-session-context"];

export type TenantSettingsRecord = {
  tenantId: string;
  showEffortSelector: boolean;
  webSearchMode: WebSearchMode;
  approvalPolicy: ApprovalPolicy;
  approvalReviewer: ApprovalReviewer;
  allowCommandExecution: boolean;
  autoApproveReadOnlyTools: boolean;
  /** Tenant-level Policy Center switch (monitor → enforce). */
  policyEnforcementMode: PolicyEnforcementMode;
  developerInstructions: string | null;
  enabledToolIds: string[];
  enabledMcpServerIds: string[];
  /** Providers whose models are selectable (still requires a configured key). */
  enabledProviders: ModelProvider[];
  /** null = all catalog models; an array is a strict allowlist of model ids. */
  enabledModelIds: string[] | null;
  /** Per-model default reasoning effort overriding the catalog default. */
  modelDefaultEfforts: Record<string, EffortLevel>;
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

function toProviderArray(value: unknown): ModelProvider[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ModelProvider =>
        (MODEL_PROVIDERS as readonly string[]).includes(entry as string)
      )
    : [...MODEL_PROVIDERS];
}

function toNullableStringArray(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : null;
}

function toEffortMap(value: unknown): Record<string, EffortLevel> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const efforts: Record<string, EffortLevel> = {};
  for (const [modelId, effort] of Object.entries(value)) {
    if ((EFFORT_LEVELS as readonly string[]).includes(effort as string)) {
      efforts[modelId] = effort as EffortLevel;
    }
  }
  return efforts;
}

function mapRow(row: Record<string, unknown>): TenantSettingsRecord {
  return {
    tenantId: String(row.tenant_id),
    showEffortSelector: Boolean(row.show_effort_selector),
    webSearchMode: parseWebSearchMode(row.web_search_mode),
    approvalPolicy: parseApprovalPolicy(row.approval_policy),
    approvalReviewer: parseApprovalReviewer(row.approval_reviewer),
    allowCommandExecution: Boolean(row.allow_command_execution),
    autoApproveReadOnlyTools: Boolean(row.auto_approve_read_only_tools),
    policyEnforcementMode: parsePolicyEnforcementMode(row.policy_enforcement_mode),
    developerInstructions: row.developer_instructions ? String(row.developer_instructions) : null,
    enabledToolIds: toStringArray(row.enabled_tool_ids),
    enabledMcpServerIds: toStringArray(row.enabled_mcp_server_ids),
    enabledProviders: toProviderArray(row.enabled_providers),
    enabledModelIds: toNullableStringArray(row.enabled_model_ids),
    modelDefaultEfforts: toEffortMap(row.model_default_efforts),
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
  showEffortSelector?: boolean;
  webSearchMode?: WebSearchMode;
  approvalPolicy?: ApprovalPolicy;
  approvalReviewer?: ApprovalReviewer;
  allowCommandExecution?: boolean;
  autoApproveReadOnlyTools?: boolean;
  policyEnforcementMode?: PolicyEnforcementMode;
  developerInstructions?: string | null;
  enabledToolIds?: string[];
  enabledMcpServerIds?: string[];
  enabledProviders?: ModelProvider[];
  enabledModelIds?: string[] | null;
  modelDefaultEfforts?: Record<string, EffortLevel>;
};

export function buildDefaultTenantSettingsInput(): Required<TenantSettingsInput> {
  return {
    showEffortSelector: false,
    webSearchMode: "disabled",
    approvalPolicy: "on-request",
    approvalReviewer: "user",
    allowCommandExecution: false,
    autoApproveReadOnlyTools: true,
    // Policy Center inert until deliberately armed — rules record decisions but
    // gate nothing until flipped to "enforce".
    policyEnforcementMode: "monitor",
    developerInstructions: null,
    enabledToolIds: [...DEFAULT_TENANT_TOOL_IDS],
    enabledMcpServerIds: [...DEFAULT_TENANT_MCP_SERVER_IDS],
    // All providers enabled by default so availability stays key-driven (the
    // pre-existing behavior) until an admin deliberately disables a provider.
    enabledProviders: [...MODEL_PROVIDERS],
    // null = every catalog model, so newly shipped models appear automatically.
    enabledModelIds: null,
    modelDefaultEfforts: {}
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

      const resolvedPolicy = Object.hasOwn(input, "approvalPolicy")
        ? (input.approvalPolicy ?? defaults.approvalPolicy)
        : (existing?.approvalPolicy ?? defaults.approvalPolicy);
      const resolvedShowEffortSelector = Object.hasOwn(input, "showEffortSelector")
        ? (input.showEffortSelector ?? defaults.showEffortSelector)
        : (existing?.showEffortSelector ?? defaults.showEffortSelector);
      const resolvedWebSearchMode = Object.hasOwn(input, "webSearchMode")
        ? (input.webSearchMode ?? defaults.webSearchMode)
        : (existing?.webSearchMode ?? defaults.webSearchMode);
      const resolvedReviewer = Object.hasOwn(input, "approvalReviewer")
        ? (input.approvalReviewer ?? defaults.approvalReviewer)
        : (existing?.approvalReviewer ?? defaults.approvalReviewer);
      const resolvedCommandExec = Object.hasOwn(input, "allowCommandExecution")
        ? (input.allowCommandExecution ?? defaults.allowCommandExecution)
        : (existing?.allowCommandExecution ?? defaults.allowCommandExecution);
      const resolvedReadOnly = Object.hasOwn(input, "autoApproveReadOnlyTools")
        ? (input.autoApproveReadOnlyTools ?? defaults.autoApproveReadOnlyTools)
        : (existing?.autoApproveReadOnlyTools ?? defaults.autoApproveReadOnlyTools);
      const resolvedPolicyEnforcementMode = Object.hasOwn(input, "policyEnforcementMode")
        ? (input.policyEnforcementMode ?? defaults.policyEnforcementMode)
        : (existing?.policyEnforcementMode ?? defaults.policyEnforcementMode);
      const resolvedInstructions = Object.hasOwn(input, "developerInstructions")
        ? (input.developerInstructions ?? defaults.developerInstructions)
        : (existing?.developerInstructions ?? defaults.developerInstructions);
      const resolvedToolIds = Object.hasOwn(input, "enabledToolIds")
        ? (input.enabledToolIds ?? defaults.enabledToolIds)
        : (existing?.enabledToolIds ?? defaults.enabledToolIds);
      const resolvedMcpIds = Object.hasOwn(input, "enabledMcpServerIds")
        ? (input.enabledMcpServerIds ?? defaults.enabledMcpServerIds)
        : (existing?.enabledMcpServerIds ?? defaults.enabledMcpServerIds);
      const resolvedProviders = Object.hasOwn(input, "enabledProviders")
        ? (input.enabledProviders ?? defaults.enabledProviders)
        : (existing?.enabledProviders ?? defaults.enabledProviders);
      // enabledModelIds is nullable-by-design: null means "all models", so an
      // explicit null in the input must persist as null (not fall back).
      const resolvedModelIds = Object.hasOwn(input, "enabledModelIds")
        ? (input.enabledModelIds ?? null)
        : (existing?.enabledModelIds ?? defaults.enabledModelIds);
      const resolvedModelEfforts = Object.hasOwn(input, "modelDefaultEfforts")
        ? (input.modelDefaultEfforts ?? defaults.modelDefaultEfforts)
        : (existing?.modelDefaultEfforts ?? defaults.modelDefaultEfforts);

      const configHash = computeConfigHash({
        tenantId,
        showEffortSelector: resolvedShowEffortSelector,
        webSearchMode: resolvedWebSearchMode,
        approvalPolicy: resolvedPolicy,
        approvalReviewer: resolvedReviewer,
        allowCommandExecution: resolvedCommandExec,
        autoApproveReadOnlyTools: resolvedReadOnly,
        policyEnforcementMode: resolvedPolicyEnforcementMode,
        developerInstructions: resolvedInstructions,
        enabledToolIds: resolvedToolIds,
        enabledMcpServerIds: resolvedMcpIds,
        enabledProviders: resolvedProviders,
        enabledModelIds: resolvedModelIds,
        modelDefaultEfforts: resolvedModelEfforts
      });

      const result = await client.query(
        `
          INSERT INTO tenant_settings (
            tenant_id,
            show_effort_selector,
            web_search_mode,
            approval_policy,
            approval_reviewer,
            allow_command_execution,
            auto_approve_read_only_tools,
            policy_enforcement_mode,
            developer_instructions,
            enabled_tool_ids,
            enabled_mcp_server_ids,
            enabled_providers,
            enabled_model_ids,
            model_default_efforts,
            version,
            config_hash,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, 1, $15, NOW())
          ON CONFLICT (tenant_id) DO UPDATE SET
            show_effort_selector = EXCLUDED.show_effort_selector,
            web_search_mode = EXCLUDED.web_search_mode,
            approval_policy = EXCLUDED.approval_policy,
            approval_reviewer = EXCLUDED.approval_reviewer,
            allow_command_execution = EXCLUDED.allow_command_execution,
            auto_approve_read_only_tools = EXCLUDED.auto_approve_read_only_tools,
            policy_enforcement_mode = EXCLUDED.policy_enforcement_mode,
            developer_instructions = EXCLUDED.developer_instructions,
            enabled_tool_ids = EXCLUDED.enabled_tool_ids,
            enabled_mcp_server_ids = EXCLUDED.enabled_mcp_server_ids,
            enabled_providers = EXCLUDED.enabled_providers,
            enabled_model_ids = EXCLUDED.enabled_model_ids,
            model_default_efforts = EXCLUDED.model_default_efforts,
            version = tenant_settings.version + 1,
            config_hash = EXCLUDED.config_hash,
            updated_at = NOW()
          RETURNING *
        `,
        [
          tenantId,
          resolvedShowEffortSelector,
          resolvedWebSearchMode,
          serializeApprovalPolicy(resolvedPolicy),
          resolvedReviewer,
          resolvedCommandExec,
          resolvedReadOnly,
          resolvedPolicyEnforcementMode,
          resolvedInstructions,
          JSON.stringify(resolvedToolIds),
          JSON.stringify(resolvedMcpIds),
          JSON.stringify(resolvedProviders),
          resolvedModelIds === null ? null : JSON.stringify(resolvedModelIds),
          JSON.stringify(resolvedModelEfforts),
          configHash
        ]
      );

      return mapRow(result.rows[0]);
    });
  }
}
