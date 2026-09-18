import {
  AdminManagedToolsListResponseSchema,
  AdminMcpServerEnvelopeSchema,
  AdminModelCatalogResponseSchema,
  CustomModelEnvelopeSchema,
  OpenRouterModelsResponseSchema,
  AdminMcpServersListResponseSchema,
  AdminRuntimeConfigSchema,
  AdminSessionDetailResponseSchema,
  AdminSessionsListResponseSchema,
  AdminSkillEnvelopeSchema,
  AdminSkillsListResponseSchema,
  AdminUserEnvelopeSchema,
  AdminUsersListResponseSchema,
  DownloadHandleEnvelopeSchema,
  PiiActivityMetricsSchema,
  PiiJobsStatsResponseSchema,
  PiiProviderStatusSchema,
  PiiRecentResponseSchema,
  PiiTopResponseSchema,
  PolicyDecisionDetailResponseSchema,
  PolicyDecisionsListResponseSchema,
  PolicyLintResponseSchema,
  PolicyRuleEnvelopeSchema,
  PolicyRulesListResponseSchema,
  PolicySimulateResponseSchema,
  RuntimeRolloutResponseSchema,
  RuntimeSessionsListResponseSchema,
  SkillImportResponseSchema,
  SkillMarketplaceResponseSchema,
  SkillRevisionFileResponseSchema,
  SkillRevisionsListResponseSchema,
  TenantProviderKeyUpdateResponseSchema,
  type TenantProviderKeyUpdateRequest,
  TenantMarketplaceManifestUrlUpdateResponseSchema,
  TenantDetailsSchema,
  TenantOkResponseSchema,
  TenantPiiProtectionUpdateResponseSchema,
  TenantSettingsEnvelopeSchema
} from "@cogniplane/shared-types";

import { buildMetricsQuery } from "./admin-pii-utils";
import { request, requestOptionalOn404 } from "./api-client";
import { parseResponse } from "./validate-response";

import type {
  AdminMcpServer,
  AdminMcpServerCreateRequest,
  AdminMcpServerUpdateRequest,
  AdminRuntimeConfig,
  AdminSessionDetailResponse,
  AdminSessionsListParams,
  AdminSessionsListResponse,
  AdminSkill,
  AdminUser,
  ApprovalPolicy,
  PiiActivityMetrics,
  PiiJobsStatsResponse,
  PiiProtectionSettings,
  PiiProviderStatus,
  PiiRangePreset,
  PiiRecentActionToken,
  PiiRecentResponse,
  PiiTopGroupBy,
  PiiTopResponse,
  PolicyDecisionDetail,
  PolicyDecisionFilters,
  PolicyDecisionsListResponse,
  PolicyEnforcementMode,
  PolicyLintWarning,
  PolicyRule,
  PolicyRuleInput,
  PolicyRulePatch,
  PolicySimulateRequest,
  PolicySimulateResponse,
  RuntimeSessionSummary,
  SkillImportResponse,
  SkillMarketplaceCatalog,
  SkillRevision,
  SkillRevisionFilePreview,
  AdminModelCatalogResponse,
  CustomModelCreateRequest,
  EffortLevel,
  Model,
  OpenRouterModelOption,
  TenantDetails,
  TenantSettings,
  WebSearchMode
} from "@cogniplane/shared-types";

export type {
  AdminManagedTool,
  SkillRevisionFilePreview
} from "@cogniplane/shared-types";

import type { ModelProvider } from "@cogniplane/shared-types";

export async function listAdminSkills(): Promise<AdminSkill[]> {
  const raw = await request<unknown>("/admin/skills");
  return parseResponse(AdminSkillsListResponseSchema, raw, "GET /admin/skills").skills;
}

export async function getSkillMarketplace(): Promise<SkillMarketplaceCatalog> {
  const raw = await request<unknown>("/admin/skills/marketplace");
  return parseResponse(SkillMarketplaceResponseSchema, raw, "GET /admin/skills/marketplace")
    .marketplace;
}

export async function disableAdminSkill(skillId: string): Promise<AdminSkill> {
  const raw = await request<unknown>(`/admin/skills/${skillId}/disable`, { method: "POST" });
  return parseResponse(AdminSkillEnvelopeSchema, raw, "POST /admin/skills/:id/disable").skill;
}

export async function publishAdminSkill(skillId: string): Promise<AdminSkill> {
  const raw = await request<unknown>(`/admin/skills/${skillId}/publish`, { method: "POST" });
  return parseResponse(AdminSkillEnvelopeSchema, raw, "POST /admin/skills/:id/publish").skill;
}

export async function unpublishAdminSkill(skillId: string): Promise<AdminSkill> {
  const raw = await request<unknown>(`/admin/skills/${skillId}/unpublish`, { method: "POST" });
  return parseResponse(AdminSkillEnvelopeSchema, raw, "POST /admin/skills/:id/unpublish").skill;
}

export async function importAdminSkillZip(file: File): Promise<SkillImportResponse> {
  const form = new FormData();
  form.set("file", file);

  const raw = await request<unknown>("/admin/skills/import/zip", {
    method: "POST",
    body: form
  });
  return parseResponse(SkillImportResponseSchema, raw, "POST /admin/skills/import/zip");
}

export async function importAdminSkillGithub(input: {
  githubUrl: string;
  ref?: string;
  subdirectory?: string;
}): Promise<SkillImportResponse> {
  const raw = await request<unknown>("/admin/skills/import/github", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(SkillImportResponseSchema, raw, "POST /admin/skills/import/github");
}

export async function importAdminSkillInline(input: {
  skillId: string;
  skillName: string;
  description: string;
  instructions: string;
}): Promise<SkillImportResponse> {
  const raw = await request<unknown>("/admin/skills/import/inline", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(SkillImportResponseSchema, raw, "POST /admin/skills/import/inline");
}

export async function listSkillRevisions(skillId: string): Promise<SkillRevision[]> {
  const raw = await request<unknown>(`/admin/skills/${skillId}/revisions`);
  return parseResponse(SkillRevisionsListResponseSchema, raw, "GET /admin/skills/:id/revisions")
    .revisions;
}

export async function getSkillRevisionFile(input: {
  skillId: string;
  skillRevisionId: number;
  path: string;
}): Promise<{ file: SkillRevisionFilePreview; limitBytes: number }> {
  const query = new URLSearchParams({ path: input.path });
  const raw = await request<unknown>(
    `/admin/skills/${input.skillId}/revisions/${input.skillRevisionId}/files?${query.toString()}`
  );
  return parseResponse(
    SkillRevisionFileResponseSchema,
    raw,
    "GET /admin/skills/:id/revisions/:rid/files"
  );
}

export async function activateSkillRevision(input: {
  skillId: string;
  skillRevisionId: number;
  reviewNotes?: string | null;
}): Promise<SkillImportResponse> {
  const raw = await request<unknown>(
    `/admin/skills/${input.skillId}/revisions/${input.skillRevisionId}/activate`,
    {
      method: "POST",
      body: JSON.stringify({ reviewNotes: input.reviewNotes ?? null })
    }
  );
  return parseResponse(
    SkillImportResponseSchema,
    raw,
    "POST /admin/skills/:id/revisions/:rid/activate"
  );
}

export async function listAdminMcpServers(): Promise<AdminMcpServer[]> {
  const raw = await request<unknown>("/admin/mcp-servers");
  return parseResponse(AdminMcpServersListResponseSchema, raw, "GET /admin/mcp-servers").mcpServers;
}

export async function listAdminManagedTools() {
  const raw = await request<unknown>("/admin/managed-tools");
  return parseResponse(AdminManagedToolsListResponseSchema, raw, "GET /admin/managed-tools").tools;
}

export async function createAdminMcpServer(
  input: AdminMcpServerCreateRequest
): Promise<AdminMcpServer> {
  const raw = await request<unknown>("/admin/mcp-servers", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(AdminMcpServerEnvelopeSchema, raw, "POST /admin/mcp-servers").mcpServer;
}

export async function updateAdminMcpServer(
  serverId: string,
  input: AdminMcpServerUpdateRequest
): Promise<AdminMcpServer> {
  const raw = await request<unknown>(`/admin/mcp-servers/${serverId}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(AdminMcpServerEnvelopeSchema, raw, "PUT /admin/mcp-servers/:id").mcpServer;
}

export async function disableAdminMcpServer(serverId: string): Promise<AdminMcpServer> {
  const raw = await request<unknown>(`/admin/mcp-servers/${serverId}/disable`, { method: "POST" });
  return parseResponse(AdminMcpServerEnvelopeSchema, raw, "POST /admin/mcp-servers/:id/disable")
    .mcpServer;
}

export async function publishAdminMcpServer(serverId: string): Promise<AdminMcpServer> {
  const raw = await request<unknown>(`/admin/mcp-servers/${serverId}/publish`, { method: "POST" });
  return parseResponse(AdminMcpServerEnvelopeSchema, raw, "POST /admin/mcp-servers/:id/publish")
    .mcpServer;
}

export async function unpublishAdminMcpServer(serverId: string): Promise<AdminMcpServer> {
  const raw = await request<unknown>(`/admin/mcp-servers/${serverId}/unpublish`, { method: "POST" });
  return parseResponse(AdminMcpServerEnvelopeSchema, raw, "POST /admin/mcp-servers/:id/unpublish")
    .mcpServer;
}

export async function listAdminSessions(
  params: AdminSessionsListParams = {}
): Promise<AdminSessionsListResponse> {
  const search = new URLSearchParams();
  if (params.userId) search.set("userId", params.userId);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.status) search.set("status", params.status);
  if (params.alert && params.alert.length > 0) {
    search.set("alert", params.alert.join(","));
  }
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit != null) search.set("limit", String(params.limit));

  const qs = search.toString();
  const raw = await request<unknown>(`/admin/sessions${qs ? `?${qs}` : ""}`);
  return parseResponse(AdminSessionsListResponseSchema, raw, "GET /admin/sessions");
}

export async function getAdminSessionDetail(
  sessionId: string
): Promise<AdminSessionDetailResponse> {
  const raw = await request<unknown>(`/admin/sessions/${sessionId}`);
  return parseResponse(AdminSessionDetailResponseSchema, raw, "GET /admin/sessions/:id");
}

export async function createAdminArtifactDownload(artifactId: string) {
  const raw = await request<unknown>(`/admin/artifacts/${artifactId}/download-token`, {
    method: "POST"
  });
  return parseResponse(
    DownloadHandleEnvelopeSchema,
    raw,
    "POST /admin/artifacts/:id/download-token"
  ).download;
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const raw = await request<unknown>("/admin/users");
  return parseResponse(AdminUsersListResponseSchema, raw, "GET /admin/users").users;
}

export async function setUserBetaTester(
  userId: string,
  isBetaTester: boolean
): Promise<AdminUser> {
  const raw = await request<unknown>(`/admin/users/${userId}/set-beta-tester`, {
    method: "POST",
    body: JSON.stringify({ isBetaTester })
  });
  return parseResponse(AdminUserEnvelopeSchema, raw, "POST /admin/users/:id/set-beta-tester").user;
}

export async function getTenantSettings(): Promise<TenantSettings> {
  const raw = await request<unknown>("/admin/tenant-settings");
  return parseResponse(TenantSettingsEnvelopeSchema, raw, "GET /admin/tenant-settings").settings;
}

/** Full model catalog + per-provider key sources (admin-only, unfiltered). */
export async function getAdminModelCatalog(): Promise<AdminModelCatalogResponse> {
  const raw = await request<unknown>("/admin/models");
  return parseResponse(AdminModelCatalogResponseSchema, raw, "GET /admin/models");
}

/** Slim OpenRouter catalog for the custom-model picker (server-proxied). */
export async function getOpenRouterModels(): Promise<OpenRouterModelOption[]> {
  const raw = await request<unknown>("/admin/openrouter-models");
  return parseResponse(OpenRouterModelsResponseSchema, raw, "GET /admin/openrouter-models").models;
}

export async function createCustomModel(input: CustomModelCreateRequest): Promise<Model> {
  const raw = await request<unknown>("/admin/custom-models", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(CustomModelEnvelopeSchema, raw, "POST /admin/custom-models").model;
}

export async function deleteCustomModel(modelId: string): Promise<TenantSettings> {
  const raw = await request<unknown>(`/admin/custom-models?modelId=${encodeURIComponent(modelId)}`, {
    method: "DELETE"
  });
  return parseResponse(TenantSettingsEnvelopeSchema, raw, "DELETE /admin/custom-models").settings;
}

/**
 * Partial tenant-settings update carrying only the model-availability fields.
 * The backend upsert leaves absent fields untouched, so this cannot stomp
 * concurrent edits to the broader Agent Settings form.
 */
export async function updateTenantModelAvailability(input: {
  enabledProviders?: ModelProvider[];
  enabledModelIds?: string[] | null;
  modelDefaultEfforts?: Record<string, EffortLevel>;
}): Promise<TenantSettings> {
  const raw = await request<unknown>("/admin/tenant-settings", {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(TenantSettingsEnvelopeSchema, raw, "PUT /admin/tenant-settings").settings;
}

export async function updateTenantAgentSettings(input: {
  showEffortSelector: boolean;
  webSearchMode: WebSearchMode;
  approvalPolicy: ApprovalPolicy;
  approvalReviewer: "user" | "guardian_subagent";
  allowCommandExecution: boolean;
  autoApproveReadOnlyTools: boolean;
  policyEnforcementMode: PolicyEnforcementMode;
  developerInstructions: string | null;
  enabledToolIds: string[];
  enabledMcpServerIds: string[];
}): Promise<TenantSettings> {
  const raw = await request<unknown>("/admin/tenant-settings", {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(TenantSettingsEnvelopeSchema, raw, "PUT /admin/tenant-settings").settings;
}

export async function listRuntimeSessions(): Promise<RuntimeSessionSummary[]> {
  const raw = await request<unknown>("/admin/runtime-sessions");
  return parseResponse(RuntimeSessionsListResponseSchema, raw, "GET /admin/runtime-sessions")
    .runtimeSessions;
}

export async function rolloutRuntimeSessions(action: "drain_idle" | "refresh_idle") {
  const raw = await request<unknown>("/admin/runtime-sessions/rollout", {
    method: "POST",
    body: JSON.stringify({ action })
  });
  return parseResponse(RuntimeRolloutResponseSchema, raw, "POST /admin/runtime-sessions/rollout");
}

export async function getRuntimeConfig(): Promise<AdminRuntimeConfig> {
  const raw = await request<unknown>("/admin/runtime-config");
  return parseResponse(AdminRuntimeConfigSchema, raw, "GET /admin/runtime-config");
}

export async function getTenantDetails(): Promise<TenantDetails> {
  const raw = await request<unknown>("/tenant");
  return parseResponse(TenantDetailsSchema, raw, "GET /tenant");
}

export async function updateTenantProviderKey(input: TenantProviderKeyUpdateRequest) {
  const raw = await request<unknown>("/tenant/settings", {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(
    TenantProviderKeyUpdateResponseSchema,
    raw,
    `PUT /tenant/settings (${input.provider})`
  );
}

export async function updateTenantMarketplaceManifestUrl(
  skillMarketplaceManifestUrl: string | null
) {
  const raw = await request<unknown>("/tenant/settings/marketplace", {
    method: "PUT",
    body: JSON.stringify({ skillMarketplaceManifestUrl })
  });
  return parseResponse(
    TenantMarketplaceManifestUrlUpdateResponseSchema,
    raw,
    "PUT /tenant/settings/marketplace"
  );
}

export async function updateTenantPiiProtection(input: PiiProtectionSettings) {
  const raw = await request<unknown>("/tenant/settings/pii", {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(
    TenantPiiProtectionUpdateResponseSchema,
    raw,
    "PUT /tenant/settings/pii"
  );
}

export async function saveTenantMicrosoftConfig(input: {
  clientId?: string;
  clientSecret?: string;
  entraTenantId?: string;
}) {
  const raw = await request<unknown>("/tenant/settings/microsoft", {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(TenantOkResponseSchema, raw, "PUT /tenant/settings/microsoft");
}

export async function deleteTenantMicrosoftConfig(): Promise<void> {
  await request<void>("/tenant/settings/microsoft", {
    method: "DELETE"
  });
}

// ─── PII admin metrics ──────────────────────────────────────────────────────

export async function getPiiProviderStatus(): Promise<PiiProviderStatus | null> {
  // 404 means the breaker isn't wired (PII_BREAKER_ENABLED=false). Treat
  // that as "no status to show" rather than an error so the UI can hide
  // the indicator instead of bleeding red.
  const raw = await requestOptionalOn404<unknown>("/admin/pii/provider-status");
  return raw === undefined ? null : parseResponse(PiiProviderStatusSchema, raw, "GET /admin/pii/provider-status");
}

export async function getAdminPiiMetrics(input: {
  range: PiiRangePreset;
  from?: string;
  to?: string;
}): Promise<PiiActivityMetrics | null> {
  const params = buildMetricsQuery(input.range, input.from, input.to);
  const raw = await requestOptionalOn404<unknown>(`/admin/pii/metrics?${params.toString()}`);
  return raw === undefined ? null : parseResponse(PiiActivityMetricsSchema, raw, "GET /admin/pii/metrics");
}

export async function getAdminPiiTop(input: {
  range: PiiRangePreset;
  from?: string;
  to?: string;
  groupBy: PiiTopGroupBy;
  limit?: number;
}): Promise<PiiTopResponse | null> {
  const params = buildMetricsQuery(input.range, input.from, input.to);
  params.set("groupBy", input.groupBy);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const raw = await requestOptionalOn404<unknown>(`/admin/pii/top?${params.toString()}`);
  return raw === undefined ? null : parseResponse(PiiTopResponseSchema, raw, "GET /admin/pii/top");
}

export async function getAdminPiiJobsStats(input: {
  range: PiiRangePreset;
  from?: string;
  to?: string;
}): Promise<PiiJobsStatsResponse | null> {
  const params = buildMetricsQuery(input.range, input.from, input.to);
  const raw = await requestOptionalOn404<unknown>(`/admin/pii/jobs/stats?${params.toString()}`);
  return raw === undefined ? null : parseResponse(PiiJobsStatsResponseSchema, raw, "GET /admin/pii/jobs/stats");
}

export async function getAdminPiiRecent(input: {
  range: PiiRangePreset;
  from?: string;
  to?: string;
  actions?: PiiRecentActionToken[];
  limit?: number;
}): Promise<PiiRecentResponse | null> {
  const params = buildMetricsQuery(input.range, input.from, input.to);
  if (input.actions && input.actions.length > 0) {
    params.set("actions", input.actions.join(","));
  }
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const raw = await requestOptionalOn404<unknown>(`/admin/pii/recent?${params.toString()}`);
  return raw === undefined ? null : parseResponse(PiiRecentResponseSchema, raw, "GET /admin/pii/recent");
}


// ── Policy Center ────────────────────────────────────────────────────────────

export async function listPolicyRules(): Promise<PolicyRule[]> {
  const raw = await request<unknown>("/admin/policy/rules");
  return parseResponse(PolicyRulesListResponseSchema, raw, "GET /admin/policy/rules").rules;
}

export async function createPolicyRule(input: PolicyRuleInput): Promise<PolicyRule> {
  const raw = await request<unknown>("/admin/policy/rules", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(PolicyRuleEnvelopeSchema, raw, "POST /admin/policy/rules").rule;
}

export async function updatePolicyRule(
  ruleId: string,
  input: PolicyRulePatch
): Promise<PolicyRule> {
  const raw = await request<unknown>(`/admin/policy/rules/${ruleId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
  return parseResponse(PolicyRuleEnvelopeSchema, raw, "PATCH /admin/policy/rules/:id").rule;
}

export async function deletePolicyRule(ruleId: string): Promise<void> {
  await request<void>(`/admin/policy/rules/${ruleId}`, { method: "DELETE" });
}

export async function simulatePolicy(input: PolicySimulateRequest): Promise<PolicySimulateResponse> {
  const raw = await request<unknown>("/admin/policy/simulate", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(PolicySimulateResponseSchema, raw, "POST /admin/policy/simulate");
}

// The list params accept arrays for the multi-value dimensions; they're serialized
// as comma-separated query values (the backend splits them back into arrays).
export type PolicyDecisionsListParams = Pick<
  PolicyDecisionFilters,
  "sessionId" | "outcomes" | "enforced" | "toolNames" | "severities" | "from" | "to" | "before" | "limit" | "offset"
>;

export async function listPolicyDecisions(
  params: PolicyDecisionsListParams = {}
): Promise<PolicyDecisionsListResponse> {
  const search = new URLSearchParams();
  if (params.sessionId) search.set("sessionId", params.sessionId);
  if (params.outcomes?.length) search.set("outcomes", params.outcomes.join(","));
  if (params.enforced !== undefined) search.set("enforced", String(params.enforced));
  if (params.toolNames?.length) search.set("toolNames", params.toolNames.join(","));
  if (params.severities?.length) search.set("severities", params.severities.join(","));
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.before) search.set("before", params.before);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const qs = search.toString();
  const raw = await request<unknown>(`/admin/policy/decisions${qs ? `?${qs}` : ""}`);
  return parseResponse(PolicyDecisionsListResponseSchema, raw, "GET /admin/policy/decisions");
}

export async function getPolicyDecision(decisionId: string): Promise<PolicyDecisionDetail> {
  const raw = await request<unknown>(`/admin/policy/decisions/${encodeURIComponent(decisionId)}`);
  return parseResponse(PolicyDecisionDetailResponseSchema, raw, "GET /admin/policy/decisions/:id").decision;
}


export async function listPolicyLintWarnings(): Promise<PolicyLintWarning[]> {
  const raw = await request<unknown>("/admin/policy/lint");
  return parseResponse(PolicyLintResponseSchema, raw, "GET /admin/policy/lint").warnings;
}

export async function reorderPolicyRules(ruleIds: string[]): Promise<PolicyRule[]> {
  const raw = await request<unknown>("/admin/policy/rules/order", {
    method: "PUT",
    body: JSON.stringify({ ruleIds })
  });
  return parseResponse(PolicyRulesListResponseSchema, raw, "PUT /admin/policy/rules/order").rules;
}
