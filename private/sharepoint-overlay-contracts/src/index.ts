// Wire contracts of the SharePoint overlay: Microsoft connection status, sites
// and OneDrive or SharePoint files. Both overlays use them. Core does not
// import this package, so the public build has no Microsoft contract.
//
// The backend overlay is bundled into the backend image, and that bundle keeps
// package imports external. Thus the overlays import this file by relative
// path, the same way that they import core, and not by package name.
import { IsoDateSchema, z } from "@cogniplane/shared-types";

export const MicrosoftUserConnectionSchema = z.object({
  microsoftUserId: z.string(),
  microsoftEmail: z.string().nullable(),
  microsoftDisplayName: z.string().nullable(),
  scopes: z.array(z.string()),
  accessTokenExpiresAt: IsoDateSchema.nullable(),
  refreshTokenExpiresAt: IsoDateSchema.nullable(),
  connectedAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastUsedAt: IsoDateSchema.nullable(),
  // A security change of the owner's account (password change, sign out
  // everywhere) suspended the connection. The agent does not use it until the
  // owner confirms it or connects again.
  suspended: z.boolean().default(false)
}).passthrough();
export type MicrosoftUserConnection = z.infer<typeof MicrosoftUserConnectionSchema>;

// The owner confirms a suspended connection for the account the page shows.
export const MicrosoftConnectionConfirmRequestSchema = z.object({
  microsoftUserId: z.string().min(1).max(200)
}).strict();
export type MicrosoftConnectionConfirmRequest = z.infer<typeof MicrosoftConnectionConfirmRequestSchema>;

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
