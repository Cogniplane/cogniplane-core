import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

// ── GitHub ────────────────────────────────────────────────────────────────────

export const GithubUserConnectionSchema = z.object({
  githubUserId: z.string(),
  githubLogin: z.string(),
  githubName: z.string().nullable(),
  githubEmail: z.string().nullable(),
  githubAvatarUrl: z.string().nullable(),
  scopes: z.array(z.string()),
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
