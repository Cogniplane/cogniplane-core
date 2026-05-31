import {
  AdminManagedToolsListResponseSchema,
  AdminMcpServerEnvelopeSchema,
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
  RuntimeOpenAiDiagnosticSchema,
  RuntimeRolloutResponseSchema,
  RuntimeSessionsListResponseSchema,
  SkillImportResponseSchema,
  SkillMarketplaceResponseSchema,
  SkillRevisionFileResponseSchema,
  SkillRevisionsListResponseSchema,
  TenantAnthropicKeyUpdateResponseSchema,
  TenantMarketplaceManifestUrlUpdateResponseSchema,
  TenantOkResponseSchema,
  TenantOpenAiKeyUpdateResponseSchema,
  TenantPiiProtectionUpdateResponseSchema,
  TenantSettingsEnvelopeSchema
} from "@cogniplane/shared-types";

import { buildMetricsQuery } from "./admin-pii-utils";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type {
  AdminMcpServer,
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
  RuntimeOpenAiDiagnostic,
  RuntimeSessionSummary,
  SkillImportResponse,
  SkillMarketplaceCatalog,
  SkillRevision,
  SkillRevisionFilePreview,
  TenantDetails,
  TenantSettings
} from "@cogniplane/shared-types";

export type {
  AdminManagedTool,
  SkillRevisionFilePreview
} from "@cogniplane/shared-types";

type TenantGithubSettings = TenantDetails["settings"]["github"];
type TenantMicrosoftOAuthSettings = TenantDetails["settings"]["microsoftOAuth"];
type TenantDetailsResponse = {
  tenantId: string;
  tenantName: string;
  slug: string;
  ssoProvider: string | null;
  plan: string;
  createdAt: string;
  updatedAt: string;
  settings?: {
    openaiApiKeyConfigured?: boolean;
    anthropicApiKeyConfigured?: boolean;
    skillMarketplaceManifestUrl?: string | null;
    piiProtection?: PiiProtectionSettings;
    github?: Partial<TenantGithubSettings>;
    microsoftOAuth?: Partial<TenantMicrosoftOAuthSettings>;
    [key: string]: unknown;
  };
};

const DEFAULT_PII_PROTECTION: PiiProtectionSettings = {
  enabled: false,
  mode: "off",
  rawRetention: "never",
  provider: { type: "openrouter", model: "" },
  scopes: { chatPrompts: true, uploads: true, microsoftImports: true },
  actions: { reportToAdmins: true },
  detectors: {
    useRulesFirst: true,
    entityTypes: ["email", "phone", "person_name", "address", "financial", "government_id"]
  }
};

const DEFAULT_TENANT_GITHUB_SETTINGS: TenantGithubSettings = {
  configured: false
};

const DEFAULT_TENANT_MICROSOFT_OAUTH_SETTINGS: TenantMicrosoftOAuthSettings = {
  configured: false
};

function normalizeTenantDetails(tenant: TenantDetailsResponse): TenantDetails {
  const settings = tenant.settings ?? {};
  const github =
    settings.github && typeof settings.github === "object"
      ? settings.github
      : {};
  const microsoftOAuth =
    settings.microsoftOAuth && typeof settings.microsoftOAuth === "object"
      ? settings.microsoftOAuth
      : {};

  return {
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
    slug: tenant.slug,
    ssoProvider: tenant.ssoProvider,
    plan: tenant.plan,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    settings: {
      ...settings,
      openaiApiKeyConfigured: Boolean(settings.openaiApiKeyConfigured),
      anthropicApiKeyConfigured: Boolean(settings.anthropicApiKeyConfigured),
      skillMarketplaceManifestUrl:
        typeof settings.skillMarketplaceManifestUrl === "string"
          ? settings.skillMarketplaceManifestUrl
          : null,
      piiProtection: settings.piiProtection ?? DEFAULT_PII_PROTECTION,
      github: {
        ...DEFAULT_TENANT_GITHUB_SETTINGS,
        ...github
      },
      microsoftOAuth: {
        ...DEFAULT_TENANT_MICROSOFT_OAUTH_SETTINGS,
        ...microsoftOAuth
      }
    }
  };
}

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

export async function createAdminMcpServer(input: {
  serverId: string;
  serverName: string;
  description?: string | null;
  transportKind?: "http";
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl?: string | null;
  headersAllowlist?: string[];
  enabled?: boolean;
}): Promise<AdminMcpServer> {
  const raw = await request<unknown>("/admin/mcp-servers", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(AdminMcpServerEnvelopeSchema, raw, "POST /admin/mcp-servers").mcpServer;
}

export async function updateAdminMcpServer(
  serverId: string,
  input: {
    serverName: string;
    description?: string | null;
    transportKind?: "http";
    mode: "managed" | "proxy";
    routePath: string;
    upstreamUrl?: string | null;
    headersAllowlist?: string[];
    enabled?: boolean;
  }
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
  if (params.runtime) search.set("runtime", params.runtime);
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

export async function updateTenantAgentSettings(input: {
  enabledRuntimeProviders: Array<"codex" | "claude-code">;
  showEffortSelector: boolean;
  approvalPolicy: ApprovalPolicy;
  approvalReviewer: "user" | "guardian_subagent";
  allowCommandExecution: boolean;
  allowUserTokenForwarding: boolean;
  autoApproveReadOnlyTools: boolean;
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

export async function runRuntimeOpenAiDiagnostic(): Promise<RuntimeOpenAiDiagnostic> {
  const raw = await request<unknown>("/admin/runtime/openai-diagnostic");
  return parseResponse(
    RuntimeOpenAiDiagnosticSchema,
    raw,
    "GET /admin/runtime/openai-diagnostic"
  );
}

export async function getRuntimeConfig(): Promise<AdminRuntimeConfig> {
  const raw = await request<unknown>("/admin/runtime-config");
  return parseResponse(AdminRuntimeConfigSchema, raw, "GET /admin/runtime-config");
}

export async function getTenantDetails(): Promise<TenantDetails> {
  // The /tenant route returns the raw permissive shape; normalize to fill in
  // default sub-objects before validating against the canonical TenantDetails
  // schema. Validation acts as a safety net on the normalize() output rather
  // than the raw response, since the raw shape is intentionally looser.
  const raw = await request<TenantDetailsResponse>("/tenant");
  return normalizeTenantDetails(raw);
}

export async function updateTenantOpenAiKey(input: { openaiApiKey: string }) {
  const raw = await request<unknown>("/tenant/settings", {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(TenantOpenAiKeyUpdateResponseSchema, raw, "PUT /tenant/settings (openai)");
}

export async function updateTenantAnthropicKey(input: { anthropicApiKey: string }) {
  const raw = await request<unknown>("/tenant/settings", {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(
    TenantAnthropicKeyUpdateResponseSchema,
    raw,
    "PUT /tenant/settings (anthropic)"
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
  try {
    const raw = await request<unknown>("/admin/pii/provider-status");
    return parseResponse(PiiProviderStatusSchema, raw, "GET /admin/pii/provider-status");
  } catch (error) {
    if (error instanceof Error && /404/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function getAdminPiiMetrics(input: {
  range: PiiRangePreset;
  from?: string;
  to?: string;
}): Promise<PiiActivityMetrics | null> {
  const params = buildMetricsQuery(input.range, input.from, input.to);
  try {
    const raw = await request<unknown>(`/admin/pii/metrics?${params.toString()}`);
    return parseResponse(PiiActivityMetricsSchema, raw, "GET /admin/pii/metrics");
  } catch (error) {
    if (error instanceof Error && /404/.test(error.message)) {
      return null;
    }
    throw error;
  }
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
  try {
    const raw = await request<unknown>(`/admin/pii/top?${params.toString()}`);
    return parseResponse(PiiTopResponseSchema, raw, "GET /admin/pii/top");
  } catch (error) {
    if (error instanceof Error && /404/.test(error.message)) return null;
    throw error;
  }
}

export async function getAdminPiiJobsStats(input: {
  range: PiiRangePreset;
  from?: string;
  to?: string;
}): Promise<PiiJobsStatsResponse | null> {
  const params = buildMetricsQuery(input.range, input.from, input.to);
  try {
    const raw = await request<unknown>(`/admin/pii/jobs/stats?${params.toString()}`);
    return parseResponse(PiiJobsStatsResponseSchema, raw, "GET /admin/pii/jobs/stats");
  } catch (error) {
    if (error instanceof Error && /404/.test(error.message)) return null;
    throw error;
  }
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
  try {
    const raw = await request<unknown>(`/admin/pii/recent?${params.toString()}`);
    return parseResponse(PiiRecentResponseSchema, raw, "GET /admin/pii/recent");
  } catch (error) {
    if (error instanceof Error && /404/.test(error.message)) return null;
    throw error;
  }
}

