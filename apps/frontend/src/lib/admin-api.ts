import {
  z,
  AdminManagedToolsListResponseSchema,
  AdminMcpServerEnvelopeSchema,
  AdminMcpConnectionTestResponseSchema,
  AdminModelCatalogResponseSchema,
  CustomModelEnvelopeSchema,
  OpenRouterModelsResponseSchema,
  AdminMcpServersListResponseSchema,
  AdminMcpWidgetDomainsResponseSchema,
  AdminRuntimeConfigSchema,
  AdminSessionDetailResponseSchema,
  AdminSessionsListResponseSchema,
  AdminSkillEnvelopeSchema,
  AdminPersonAccessResponseSchema,
  AdminSkillReleaseImpactResponseSchema,
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
  PolicyMonitorSummaryResponseSchema,
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
  TenantPiiProtectionUpdateResponseSchema,
  TenantSettingsEnvelopeSchema
} from "@cogniplane/shared-types";

import { buildMetricsQuery } from "./admin-pii-utils";
import { requestJson, requestEmpty, requestJsonOptionalOn404 } from "./api-client";

import type {
  AdminMcpServer,
  AdminMcpConnectionTest,
  AdminMcpServerCreateRequest,
  AdminMcpServerSetupEdit,
  AdminMcpWidgetDomainChangeRequest,
  AdminMcpWidgetDomains,
  AdminRuntimeConfig,
  AdminSessionDetailResponse,
  AdminSessionsListParams,
  AdminSessionsListResponse,
  AdminSkill,
  AdminPersonAccessResponse,
  AdminSkillReleaseImpact,
  AdminSkillReleaseSnapshot,
  AdminUser,
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
  PolicyLintWarning,
  PolicyMonitorSummaryResponse,
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
  Model,
  OpenRouterModelOption,
  TenantDetails,
  TenantSettings
} from "@cogniplane/shared-types";
import type { TenantSettingsUpdateRequest } from "@cogniplane/shared-types/tenant-settings-request";

export type {
  AdminManagedTool,
  SkillRevisionFilePreview
} from "@cogniplane/shared-types";

/**
 * Build "?a=1&b=x,y" from list filters. Empty strings, empty arrays, null, and
 * undefined are left out; false and 0 are sent. Arrays are comma-separated, and
 * the backend splits them back into arrays.
 */
function toQueryString(params: Record<string, string | number | boolean | readonly string[] | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export async function listAdminSkills(): Promise<AdminSkill[]> {
  return (await requestJson("/admin/skills", AdminSkillsListResponseSchema)).skills;
}

export async function getSkillMarketplace(): Promise<SkillMarketplaceCatalog> {
  return (await requestJson("/admin/skills/marketplace", SkillMarketplaceResponseSchema)).marketplace;
}

export async function previewAdminSkillRelease(skillId: string, input: {
  action: "activate" | "audience";
  revisionId: number | null;
  audience: "off" | "test-users" | "members";
}): Promise<AdminSkillReleaseImpact> {
  const path = `/admin/skills/${encodeURIComponent(skillId)}/release-impact`;
  return await requestJson(path, AdminSkillReleaseImpactResponseSchema, { method: "POST", body: JSON.stringify(input) });
}

export async function disableAdminSkill(skillId: string, expectedSnapshot: AdminSkillReleaseSnapshot): Promise<AdminSkill> {
  return (await requestJson(`/admin/skills/${skillId}/disable`, AdminSkillEnvelopeSchema, { method: "POST", body: JSON.stringify({ expectedSnapshot }) })).skill;
}

export async function publishAdminSkill(skillId: string, expectedSnapshot: AdminSkillReleaseSnapshot): Promise<AdminSkill> {
  return (await requestJson(`/admin/skills/${skillId}/publish`, AdminSkillEnvelopeSchema, { method: "POST", body: JSON.stringify({ expectedSnapshot }) })).skill;
}

export async function unpublishAdminSkill(skillId: string, expectedSnapshot: AdminSkillReleaseSnapshot): Promise<AdminSkill> {
  return (await requestJson(`/admin/skills/${skillId}/unpublish`, AdminSkillEnvelopeSchema, { method: "POST", body: JSON.stringify({ expectedSnapshot }) })).skill;
}

export async function importAdminSkillZip(file: File): Promise<SkillImportResponse> {
  const form = new FormData();
  form.set("file", file);

  return await requestJson("/admin/skills/import/zip", SkillImportResponseSchema, {
    method: "POST",
    body: form
  });
}

export async function importAdminSkillGithub(input: {
  githubUrl: string;
  ref?: string;
  subdirectory?: string;
}): Promise<SkillImportResponse> {
  return await requestJson("/admin/skills/import/github", SkillImportResponseSchema, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function importAdminSkillInline(input: {
  skillId: string;
  skillName: string;
  description: string;
  instructions: string;
}): Promise<SkillImportResponse> {
  return await requestJson("/admin/skills/import/inline", SkillImportResponseSchema, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function listSkillRevisions(skillId: string): Promise<SkillRevision[]> {
  return (await requestJson(`/admin/skills/${skillId}/revisions`, SkillRevisionsListResponseSchema)).revisions;
}

export async function getSkillRevisionFile(input: {
  skillId: string;
  skillRevisionId: number;
  path: string;
}): Promise<{ file: SkillRevisionFilePreview; limitBytes: number }> {
  const query = new URLSearchParams({ path: input.path });
  return await requestJson(`/admin/skills/${input.skillId}/revisions/${input.skillRevisionId}/files?${query.toString()}`, SkillRevisionFileResponseSchema);
}

export async function activateSkillRevision(input: {
  skillId: string;
  skillRevisionId: number;
  reviewNotes?: string | null;
  audience?: "test-users" | "members";
  expectedSnapshot: AdminSkillReleaseSnapshot;
}): Promise<SkillImportResponse> {
  return await requestJson(`/admin/skills/${input.skillId}/revisions/${input.skillRevisionId}/activate`, SkillImportResponseSchema, {
      method: "POST",
      body: JSON.stringify({ reviewNotes: input.reviewNotes ?? null, audience: input.audience, expectedSnapshot: input.expectedSnapshot })
    });
}

export async function listAdminMcpServers(): Promise<AdminMcpServer[]> {
  return (await requestJson("/admin/mcp-servers", AdminMcpServersListResponseSchema)).mcpServers;
}

export async function testAdminMcpConnection(serverId: string, input: {
  expectedVersion: number;
  expectedConfigHash: string;
}): Promise<AdminMcpConnectionTest> {
  const path = `/admin/mcp-servers/${encodeURIComponent(serverId)}/connection-test`;
  return (await requestJson(path, AdminMcpConnectionTestResponseSchema, { method: "POST", body: JSON.stringify(input) })).connectionTest;
}

export async function getAdminMcpWidgetDomains(serverId: string): Promise<AdminMcpWidgetDomains> {
  const path = `/admin/mcp-servers/${encodeURIComponent(serverId)}/widget-domains`;
  return (await requestJson(path, AdminMcpWidgetDomainsResponseSchema)).widgetDomains;
}

export async function changeAdminMcpWidgetDomain(
  serverId: string,
  action: "approve" | "revoke",
  input: AdminMcpWidgetDomainChangeRequest
): Promise<AdminMcpWidgetDomains> {
  const path = `/admin/mcp-servers/${encodeURIComponent(serverId)}/widget-domains/${action}`;
  return (await requestJson(path, AdminMcpWidgetDomainsResponseSchema, { method: "POST", body: JSON.stringify(input) })).widgetDomains;
}

export async function listAdminManagedTools() {
  return (await requestJson("/admin/managed-tools", AdminManagedToolsListResponseSchema)).tools;
}

export type McpAudience = "off" | "test_users" | "members";

/** An edit of a saved connection: its ID and the saved version that the draft started from. */
export type McpConnectionEdit = { serverId: string } & AdminMcpServerSetupEdit;

/**
 * Creates a connection (`editing` null) or saves an edit. The backend refuses
 * an edit whose `expectedVersion` is not the saved version with 409
 * `mcp_server_conflict`.
 */
export async function saveAdminMcpConnection(
  input: AdminMcpServerCreateRequest & { audience: McpAudience },
  editing: McpConnectionEdit | null
): Promise<AdminMcpServer> {
  const path = editing
    ? `/admin/mcp-servers/${encodeURIComponent(editing.serverId)}/setup`
    : "/admin/mcp-servers/setup";
  return (await requestJson(path, AdminMcpServerEnvelopeSchema, {
    method: editing ? "PUT" : "POST",
    body: JSON.stringify(editing ? { ...input, expectedVersion: editing.expectedVersion } : input)
  })).mcpServer;
}

export async function setInheritedAdminMcpAudience(
  serverId: string,
  audience: McpAudience
): Promise<AdminMcpServer> {
  const path = `/admin/mcp-servers/${encodeURIComponent(serverId)}/inherited-availability`;
  return (await requestJson(path, AdminMcpServerEnvelopeSchema, {
    method: "PUT",
    body: JSON.stringify({ audience })
  })).mcpServer;
}

export async function listAdminSessions(
  params: AdminSessionsListParams = {}
): Promise<AdminSessionsListResponse> {
  return await requestJson(`/admin/sessions${toQueryString(params)}`, AdminSessionsListResponseSchema);
}

export async function getAdminSessionDetail(
  sessionId: string
): Promise<AdminSessionDetailResponse> {
  return await requestJson(`/admin/sessions/${sessionId}`, AdminSessionDetailResponseSchema);
}

export async function createAdminArtifactDownload(artifactId: string) {
  return (await requestJson(`/admin/artifacts/${artifactId}/download-token`, DownloadHandleEnvelopeSchema, {
    method: "POST"
  })).download;
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  return (await requestJson("/admin/users", AdminUsersListResponseSchema)).users;
}

export async function setUserBetaTester(
  userId: string,
  isBetaTester: boolean
): Promise<AdminUser> {
  return (await requestJson(`/admin/users/${userId}/set-beta-tester`, AdminUserEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify({ isBetaTester })
  })).user;
}

/**
 * Organization skills and connections for one member's new standalone chat.
 * The result must name the requested tenant and member; a mismatch is an
 * error, so a stale or misrouted response never shows as this person's access.
 */
export async function getAdminPersonAccess(
  userId: string,
  expected: { tenantId: string }
): Promise<AdminPersonAccessResponse> {
  const path = `/admin/users/${encodeURIComponent(userId)}/skills-connections`;
  const result = await requestJson(path, AdminPersonAccessResponseSchema);
  if (result.userId !== userId || result.tenantId !== expected.tenantId) {
    throw new Error("The server returned a result for a different person or organization.");
  }
  return result;
}

// Member role and removal live on the tenant routes. The backend enforces who
// may change what (apps/backend/src/routes/tenant.ts); callers show only the
// permitted actions and map the error codes for the rest.
/** `stepUpToken`: required to change the role of a local account. */
export async function changeMemberRole(userId: string, role: AdminUser["role"], stepUpToken?: string): Promise<void> {
  await requestEmpty(`/tenant/members/${encodeURIComponent(userId)}/role`, {
    method: "PUT",
    body: JSON.stringify({ role }),
    ...(stepUpToken ? { headers: { "X-Step-Up": stepUpToken } } : {})
  });
}

/** `stepUpToken`: required to remove a member of a tenant with local login. */
export async function removeMember(userId: string, stepUpToken?: string): Promise<void> {
  await requestEmpty(`/tenant/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    ...(stepUpToken ? { headers: { "X-Step-Up": stepUpToken } } : {})
  });
}

export async function getTenantSettings(): Promise<TenantSettings> {
  return (await requestJson("/admin/tenant-settings", TenantSettingsEnvelopeSchema)).settings;
}

/** Full model catalog + per-provider key sources (admin-only, unfiltered). */
export async function getAdminModelCatalog(): Promise<AdminModelCatalogResponse> {
  return await requestJson("/admin/models", AdminModelCatalogResponseSchema);
}

/** Slim OpenRouter catalog for the custom-model picker (server-proxied). */
export async function getOpenRouterModels(): Promise<OpenRouterModelOption[]> {
  return (await requestJson("/admin/openrouter-models", OpenRouterModelsResponseSchema)).models;
}

export async function createCustomModel(input: CustomModelCreateRequest): Promise<Model> {
  return (await requestJson("/admin/custom-models", CustomModelEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(input)
  })).model;
}

export async function deleteCustomModel(modelId: string): Promise<TenantSettings> {
  return (await requestJson(`/admin/custom-models?modelId=${encodeURIComponent(modelId)}`, TenantSettingsEnvelopeSchema, {
    method: "DELETE"
  })).settings;
}

// Both settings pages send a subset of the shared request schema
// (`TenantSettingsUpdateRequest`) and always the version that they loaded.
// The Models page sends the model fields; Agent behavior sends the others.
type ModelAvailabilityField =
  "enabledProviders" | "enabledModelIds" | "defaultModelId" | "modelDefaultEfforts" | "showEffortSelector";
type AgentSettingsField =
  | "showEffortSelector"
  | "webSearchMode"
  | "approvalPolicy"
  | "approvalReviewer"
  | "allowCommandExecution"
  | "autoApproveReadOnlyTools"
  | "policyEnforcementMode"
  | "developerInstructions"
  | "enabledToolIds"
  | "enabledMcpServerIds"
  | "approvedSandboxEgressDomains";
export type TenantModelAvailabilityUpdate =
  { expectedVersion: number } & Pick<TenantSettingsUpdateRequest, ModelAvailabilityField>;
export type TenantAgentSettingsUpdate =
  { expectedVersion: number } & Pick<TenantSettingsUpdateRequest, AgentSettingsField>;

/**
 * Partial tenant-settings update carrying only the model-availability fields.
 * The backend upsert leaves absent fields untouched, so this cannot stomp
 * concurrent edits to the broader Agent Settings form.
 */
export async function updateTenantModelAvailability(input: TenantModelAvailabilityUpdate): Promise<TenantSettings> {
  return (await requestJson("/admin/tenant-settings", TenantSettingsEnvelopeSchema, {
    method: "PUT",
    body: JSON.stringify(input)
  })).settings;
}

export async function updateTenantAgentSettings(input: TenantAgentSettingsUpdate): Promise<TenantSettings> {
  return (await requestJson("/admin/tenant-settings", TenantSettingsEnvelopeSchema, {
    method: "PUT",
    body: JSON.stringify(input)
  })).settings;
}

export async function listRuntimeSessions(): Promise<RuntimeSessionSummary[]> {
  return (await requestJson("/admin/runtime-sessions", RuntimeSessionsListResponseSchema)).runtimeSessions;
}

export async function rolloutRuntimeSessions(action: "drain_idle" | "refresh_idle") {
  return await requestJson("/admin/runtime-sessions/rollout", RuntimeRolloutResponseSchema, {
    method: "POST",
    body: JSON.stringify({ action })
  });
}

export async function getRuntimeConfig(): Promise<AdminRuntimeConfig> {
  return await requestJson("/admin/runtime-config", AdminRuntimeConfigSchema);
}

export type BackendBuild = { sha: string; buildDate: string };

// `version` is optional: a backend older than this frontend can answer without it.
const BackendBuildResponseSchema = z.object({
  version: z.object({ sha: z.string(), buildDate: z.string() }).optional()
});

/** The backend build, from the admin-only diagnostics. The public health
 *  check does not report it. */
export async function getBackendBuild(): Promise<BackendBuild> {
  const { version } = await requestJson("/admin/diagnostics", BackendBuildResponseSchema);
  if (!version) throw new Error("GET /admin/diagnostics returned no build.");
  return { sha: version.sha, buildDate: version.buildDate };
}

export async function getTenantDetails(): Promise<TenantDetails> {
  return await requestJson("/tenant", TenantDetailsSchema);
}

export async function updateTenantProviderKey(input: TenantProviderKeyUpdateRequest) {
  return await requestJson("/tenant/settings", TenantProviderKeyUpdateResponseSchema, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export async function updateTenantMarketplaceManifestUrl(
  skillMarketplaceManifestUrl: string | null
) {
  return await requestJson("/tenant/settings/marketplace", TenantMarketplaceManifestUrlUpdateResponseSchema, {
    method: "PUT",
    body: JSON.stringify({ skillMarketplaceManifestUrl })
  });
}

// Send the revision that the form loaded. The server then refuses the save with
// 409 `pii_settings_conflict` when another session saved first. A server older
// than the revision sends none, so the save then has no revision.
export async function updateTenantPiiProtection(input: PiiProtectionSettings, expectedRevision?: number) {
  return await requestJson("/tenant/settings/pii", TenantPiiProtectionUpdateResponseSchema, {
    method: "PUT",
    body: JSON.stringify(expectedRevision === undefined ? input : { ...input, expectedRevision })
  });
}

export async function getPiiProviderStatus(): Promise<PiiProviderStatus | null> {
  // 404 means the breaker isn't wired (PII_BREAKER_ENABLED=false). Treat
  // that as "no status to show" rather than an error so the UI can hide
  // the indicator instead of bleeding red.
  return (await requestJsonOptionalOn404("/admin/pii/provider-status", PiiProviderStatusSchema)) ?? null;
}

export async function getAdminPiiMetrics(input: {
  range: PiiRangePreset;
  from?: string;
  to?: string;
}): Promise<PiiActivityMetrics | null> {
  const params = buildMetricsQuery(input.range, input.from, input.to);
  return (await requestJsonOptionalOn404(`/admin/pii/metrics?${params.toString()}`, PiiActivityMetricsSchema)) ?? null;
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
  return (await requestJsonOptionalOn404(`/admin/pii/top?${params.toString()}`, PiiTopResponseSchema)) ?? null;
}

export async function getAdminPiiJobsStats(input: {
  range: PiiRangePreset;
  from?: string;
  to?: string;
}): Promise<PiiJobsStatsResponse | null> {
  const params = buildMetricsQuery(input.range, input.from, input.to);
  return (await requestJsonOptionalOn404(`/admin/pii/jobs/stats?${params.toString()}`, PiiJobsStatsResponseSchema)) ?? null;
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
  return (await requestJsonOptionalOn404(`/admin/pii/recent?${params.toString()}`, PiiRecentResponseSchema)) ?? null;
}


// ── Policy Center ────────────────────────────────────────────────────────────

export async function listPolicyRules(): Promise<PolicyRule[]> {
  return (await requestJson("/admin/policy/rules", PolicyRulesListResponseSchema)).rules;
}

export async function createPolicyRule(input: PolicyRuleInput): Promise<PolicyRule> {
  return (await requestJson("/admin/policy/rules", PolicyRuleEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(input)
  })).rule;
}

export async function updatePolicyRule(
  ruleId: string,
  input: PolicyRulePatch
): Promise<PolicyRule> {
  return (await requestJson(`/admin/policy/rules/${ruleId}`, PolicyRuleEnvelopeSchema, {
    method: "PATCH",
    body: JSON.stringify(input)
  })).rule;
}

export async function deletePolicyRule(ruleId: string): Promise<void> {
  await requestEmpty(`/admin/policy/rules/${ruleId}`, { method: "DELETE" });
}

export async function simulatePolicy(input: PolicySimulateRequest): Promise<PolicySimulateResponse> {
  return await requestJson("/admin/policy/simulate", PolicySimulateResponseSchema, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

// The list params accept arrays for the multi-value dimensions; they're serialized
// as comma-separated query values (the backend splits them back into arrays).
export type PolicyDecisionsListParams = Pick<
  PolicyDecisionFilters,
  | "sessionId"
  | "matchedRuleId"
  | "evidence"
  | "outcomes"
  | "enforced"
  | "toolNames"
  | "severities"
  | "from"
  | "to"
  | "before"
  | "limit"
  | "offset"
>;

export async function listPolicyDecisions(
  params: PolicyDecisionsListParams = {}
): Promise<PolicyDecisionsListResponse> {
  return await requestJson(`/admin/policy/decisions${toQueryString(params)}`, PolicyDecisionsListResponseSchema);
}

export async function getPolicyMonitorSummary(): Promise<PolicyMonitorSummaryResponse> {
  return await requestJson("/admin/policy/monitor-summary", PolicyMonitorSummaryResponseSchema);
}

export async function getPolicyDecision(decisionId: string): Promise<PolicyDecisionDetail> {
  return (await requestJson(`/admin/policy/decisions/${encodeURIComponent(decisionId)}`, PolicyDecisionDetailResponseSchema)).decision;
}


export async function listPolicyLintWarnings(): Promise<PolicyLintWarning[]> {
  return (await requestJson("/admin/policy/lint", PolicyLintResponseSchema)).warnings;
}

export async function reorderPolicyRules(ruleIds: string[]): Promise<PolicyRule[]> {
  return (await requestJson("/admin/policy/rules/order", PolicyRulesListResponseSchema, {
    method: "PUT",
    body: JSON.stringify({ ruleIds })
  })).rules;
}
