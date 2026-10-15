import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

// ── GitHub ────────────────────────────────────────────────────────────────────

/** Most repositories one GitHub connection can allow. */
export const GITHUB_ALLOWED_REPOSITORY_LIMIT = 200;

const GITHUB_REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Split `owner/name`, or return null when the value is not a plain repository
 * name. The caller must not trim or fix the value: the same check runs on
 * model-supplied tool arguments, which become part of a GitHub API URL.
 * The character class permits a segment of only dots, so `.` and `..` are
 * rejected here. The URL parser would otherwise resolve them and send the
 * request to a different API endpoint.
 */
export function parseGithubRepositoryName(value: string): { owner: string; name: string } | null {
  if (!GITHUB_REPOSITORY_NAME_PATTERN.test(value)) return null;
  const [owner, name] = value.split("/", 2) as [string, string];
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return { owner, name };
}

export const GithubRepositoryNameSchema = z
  .string()
  .trim()
  .refine((value) => parseGithubRepositoryName(value) !== null, {
    message: "Use the form owner/name."
  });

export const GithubAllowedRepositoriesRequestSchema = z.object({
  // The GitHub account that the member saw when they chose the list. The save
  // fails when the connected account is a different one.
  githubUserId: z.string().min(1).max(64),
  repositories: z.array(GithubRepositoryNameSchema).max(GITHUB_ALLOWED_REPOSITORY_LIMIT)
}).strict();
export type GithubAllowedRepositoriesRequest = z.infer<typeof GithubAllowedRepositoriesRequestSchema>;

export const GithubAllowedRepositoriesResponseSchema = z.object({
  allowedRepositories: z.array(z.string())
});
export type GithubAllowedRepositoriesResponse = z.infer<typeof GithubAllowedRepositoriesResponseSchema>;

export const GithubRepositoryOptionSchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  archived: z.boolean()
});
export type GithubRepositoryOption = z.infer<typeof GithubRepositoryOptionSchema>;

export const GithubRepositoryListResponseSchema = z.object({
  repositories: z.array(GithubRepositoryOptionSchema),
  // True when the account has more repositories than one listing returns.
  truncated: z.boolean()
});
export type GithubRepositoryListResponse = z.infer<typeof GithubRepositoryListResponseSchema>;

export const GithubUserConnectionSchema = z.object({
  githubUserId: z.string(),
  githubLogin: z.string(),
  githubName: z.string().nullable(),
  githubEmail: z.string().nullable(),
  githubAvatarUrl: z.string().nullable(),
  scopes: z.array(z.string()),
  // Repositories the agent may use, lower case. Empty means the agent may use none.
  allowedRepositories: z.array(z.string()),
  accessTokenExpiresAt: IsoDateSchema.nullable(),
  refreshTokenExpiresAt: IsoDateSchema.nullable(),
  connectedAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastUsedAt: IsoDateSchema.nullable()
}).passthrough();
export type GithubUserConnection = z.infer<typeof GithubUserConnectionSchema>;

export const GithubConnectionStatusSchema = z.object({
  configured: z.boolean(),
  userConnection: GithubUserConnectionSchema.nullable(),
  tenantEnabled: z.boolean().optional(),
  tenantReadsEnabled: z.boolean().optional(),
  tenantWritesEnabled: z.boolean().optional(),
  platformConfigured: z.boolean().optional()
}).passthrough();
export type GithubConnectionStatus = z.infer<typeof GithubConnectionStatusSchema>;

// ── Microsoft ─────────────────────────────────────────────────────────────────

export const MicrosoftUserConnectionSchema = z.object({
  microsoftUserId: z.string(),
  microsoftEmail: z.string().nullable(),
  microsoftDisplayName: z.string().nullable(),
  scopes: z.array(z.string()),
  accessTokenExpiresAt: IsoDateSchema.nullable(),
  refreshTokenExpiresAt: IsoDateSchema.nullable(),
  connectedAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastUsedAt: IsoDateSchema.nullable()
}).passthrough();
export type MicrosoftUserConnection = z.infer<typeof MicrosoftUserConnectionSchema>;

export const MicrosoftConnectionStatusSchema = z.object({
  configured: z.boolean(),
  userConnection: MicrosoftUserConnectionSchema.nullable(),
  tenantEnabled: z.boolean().optional(),
  tenantReadsEnabled: z.boolean().optional(),
  tenantWritesEnabled: z.boolean().optional(),
  platformConfigured: z.boolean().optional()
}).passthrough();
export type MicrosoftConnectionStatus = z.infer<typeof MicrosoftConnectionStatusSchema>;

export const MicrosoftSiteSchema = z.object({
  siteId: z.string(),
  name: z.string().nullable(),
  displayName: z.string().nullable(),
  webUrl: z.string().nullable()
}).passthrough();
export type MicrosoftSite = z.infer<typeof MicrosoftSiteSchema>;

export const MicrosoftSitesListResponseSchema = z.object({
  sites: z.array(MicrosoftSiteSchema)
}).passthrough();
export type MicrosoftSitesListResponse = z.infer<typeof MicrosoftSitesListResponseSchema>;

export const MicrosoftFileSchema = z.object({
  itemId: z.string(),
  driveId: z.string(),
  parentId: z.string().nullable(),
  siteId: z.string().nullable(),
  name: z.string(),
  webUrl: z.string().nullable(),
  size: z.number().nullable(),
  mimeType: z.string().nullable(),
  isFolder: z.boolean(),
  isFile: z.boolean(),
  lastModifiedDateTime: z.string().nullable(),
  path: z.string().nullable(),
  source: z.enum(["onedrive", "sharepoint"]),
  summary: z.string().nullable().optional()
}).passthrough();
export type MicrosoftFile = z.infer<typeof MicrosoftFileSchema>;

export const MicrosoftFilesListResponseSchema = z.object({
  items: z.array(MicrosoftFileSchema)
}).passthrough();
export type MicrosoftFilesListResponse = z.infer<typeof MicrosoftFilesListResponseSchema>;

export const MicrosoftFilesSearchResponseSchema = z.object({
  results: z.array(MicrosoftFileSchema)
}).passthrough();
export type MicrosoftFilesSearchResponse = z.infer<typeof MicrosoftFilesSearchResponseSchema>;

// ── Notion ────────────────────────────────────────────────────────────────────

export const NotionUserConnectionSchema = z.object({
  notionUserId: z.string(),
  notionWorkspaceId: z.string().nullable(),
  notionWorkspaceName: z.string().nullable(),
  notionWorkspaceIcon: z.string().nullable(),
  notionOwnerEmail: z.string().nullable(),
  notionOwnerName: z.string().nullable(),
  scopes: z.array(z.string()),
  accessTokenExpiresAt: IsoDateSchema.nullable(),
  refreshTokenExpiresAt: IsoDateSchema.nullable(),
  connectedAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastUsedAt: IsoDateSchema.nullable()
}).passthrough();
export type NotionUserConnection = z.infer<typeof NotionUserConnectionSchema>;

export const NotionConnectionStatusSchema = z.object({
  configured: z.boolean(),
  userConnection: NotionUserConnectionSchema.nullable(),
  tenantEnabled: z.boolean().optional(),
  tenantReadsEnabled: z.boolean().optional(),
  tenantWritesEnabled: z.boolean().optional(),
  platformConfigured: z.boolean().optional()
}).passthrough();
export type NotionConnectionStatus = z.infer<typeof NotionConnectionStatusSchema>;

// ── Jira (personal connection through Pipedream Connect) ─────────────────────

export const JiraSiteSchema = z.object({
  siteId: z.string(),
  name: z.string(),
  url: z.string()
}).passthrough();
export type JiraSite = z.infer<typeof JiraSiteSchema>;

export const JiraUserConnectionSchema = z.object({
  accountId: z.string(),
  accountName: z.string().nullable(),
  site: JiraSiteSchema,
  connectedAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).passthrough();
export type JiraUserConnection = z.infer<typeof JiraUserConnectionSchema>;

export const JiraConnectionStatusSchema = z.object({
  configured: z.boolean(),
  userConnection: JiraUserConnectionSchema.nullable(),
  // The member started an authorization for the current identity, so
  // Pipedream can hold accounts that have no selected site.
  authorizationStarted: z.boolean(),
  // An earlier disconnect or member removal did not finish in Pipedream.
  cleanupPending: z.boolean(),
  tenantEnabled: z.boolean().optional(),
  tenantReadsEnabled: z.boolean().optional(),
  tenantWritesEnabled: z.boolean().optional(),
  platformConfigured: z.boolean().optional()
}).passthrough();
export type JiraConnectionStatus = z.infer<typeof JiraConnectionStatusSchema>;

// Accounts the user authorized in Pipedream. Sites are loaded per account
// with `GET /me/jira-connection/accounts/:accountId/sites`.
export const JiraAccountCandidateSchema = z.object({
  accountId: z.string(),
  accountName: z.string().nullable(),
  healthy: z.boolean(),
  createdAt: IsoDateSchema.nullable()
}).passthrough();
export type JiraAccountCandidate = z.infer<typeof JiraAccountCandidateSchema>;

export const JiraAccountCandidatesResponseSchema = z.object({
  accounts: z.array(JiraAccountCandidateSchema)
}).passthrough();
export type JiraAccountCandidatesResponse = z.infer<typeof JiraAccountCandidatesResponseSchema>;

export const JiraAccountSitesResponseSchema = z.object({
  sites: z.array(JiraSiteSchema)
}).passthrough();
export type JiraAccountSitesResponse = z.infer<typeof JiraAccountSitesResponseSchema>;

export const JiraAccountIdSchema = z.string().regex(/^apn_[A-Za-z0-9]+$/);

// Remote Jira cleanup that did not finish, for tenant administrators.
export const JiraCleanupSchema = z.object({
  cleanupId: z.string().uuid(),
  userId: z.string(),
  accountId: z.string().nullable(),
  reason: z.enum(["user_disconnect", "member_removed", "project_changed"]),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).passthrough();
export type JiraCleanup = z.infer<typeof JiraCleanupSchema>;

export const JiraCleanupListResponseSchema = z.object({
  cleanups: z.array(JiraCleanupSchema)
}).passthrough();
export type JiraCleanupListResponse = z.infer<typeof JiraCleanupListResponseSchema>;

export const JiraConnectionSelectRequestSchema = z.object({
  accountId: JiraAccountIdSchema,
  siteId: z.string().uuid()
}).strict();
export type JiraConnectionSelectRequest = z.infer<typeof JiraConnectionSelectRequestSchema>;

// ── Generic integration views (admin + user-facing) ───────────────────────────

export const IntegrationStatusSchema = z.enum(["available", "coming_soon"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const IntegrationConfigModeSchema = z.enum(["none", "oauth_app"]);
export type IntegrationConfigMode = z.infer<typeof IntegrationConfigModeSchema>;

export const IntegrationConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "password", "url"]),
  required: z.boolean(),
  helpText: z.string().optional()
}).passthrough();
export type IntegrationConfigField = z.infer<typeof IntegrationConfigFieldSchema>;

export const AdminIntegrationViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  longDescription: z.string(),
  logoSlug: z.string(),
  status: IntegrationStatusSchema,
  category: z.string(),
  readToolIds: z.array(z.string()),
  writeToolIds: z.array(z.string()),
  configMode: IntegrationConfigModeSchema,
  configFields: z.array(IntegrationConfigFieldSchema).optional(),
  docsUrl: z.string().optional(),
  readsEnabled: z.boolean(),
  writesEnabled: z.boolean(),
  hasConfig: z.boolean(),
  configSummary: z.record(z.string(), z.string()),
  updatedAt: IsoDateSchema.nullable(),
  updatedBy: z.string().nullable(),
  platformConfigured: z.boolean(),
  platformConfigMessage: z.string().nullable()
}).passthrough();
export type AdminIntegrationView = z.infer<typeof AdminIntegrationViewSchema>;

export const AdminIntegrationsListResponseSchema = z.object({
  integrations: z.array(AdminIntegrationViewSchema)
}).passthrough();
export type AdminIntegrationsListResponse = z.infer<typeof AdminIntegrationsListResponseSchema>;

export const AdminIntegrationEnvelopeSchema = z.object({
  integration: AdminIntegrationViewSchema
}).passthrough();
export type AdminIntegrationEnvelope = z.infer<typeof AdminIntegrationEnvelopeSchema>;

export const UserIntegrationViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  logoSlug: z.string(),
  category: z.string(),
  readsEnabled: z.boolean(),
  writesEnabled: z.boolean()
}).passthrough();
export type UserIntegrationView = z.infer<typeof UserIntegrationViewSchema>;

export const UserIntegrationsAvailabilityResponseSchema = z.object({
  enabled: z.array(UserIntegrationViewSchema)
}).passthrough();
export type UserIntegrationsAvailabilityResponse = z.infer<typeof UserIntegrationsAvailabilityResponseSchema>;

// ── OAuth authorization-URL envelopes (GitHub / Notion / etc.) ───────────────

export const OAuthAuthorizationUrlResponseSchema = z.object({
  url: z.string()
}).passthrough();
export type OAuthAuthorizationUrlResponse = z.infer<typeof OAuthAuthorizationUrlResponseSchema>;
