import { z } from "zod";

import { AdminIdSchema, IsoDateSchema } from "./_helpers.js";

export const AdminMcpServerSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  description: z.string().nullable(),
  transportKind: z.literal("http"),
  mode: z.enum(["managed", "proxy"]),
  routePath: z.string(),
  upstreamUrl: z.string().nullable(),
  upstreamAuthType: z.enum(["none", "bearer", "header", "query"]),
  upstreamAuthName: z.string().nullable(),
  upstreamAuthConfigured: z.boolean(),
  version: z.number(),
  configHash: z.string(),
  enabled: z.boolean(),
  isPublished: z.boolean(),
  createdBy: z.string(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  invokedSessions30d: z.number().optional(),
  materializedSessions30d: z.number().optional()
}).passthrough();
export type AdminMcpServer = z.infer<typeof AdminMcpServerSchema>;

const AdminMcpServerMutationFields = {
  serverName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  transportKind: z.literal("http").default("http"),
  mode: z.enum(["managed", "proxy"]),
  routePath: z.string().trim().min(1).max(200),
  // Backend routes additionally enforce HTTPS and reject unsafe hosts and credentials.
  upstreamUrl: z.string().url().nullable().optional(),
  upstreamAuthType: z.enum(["none", "bearer", "header", "query"]).default("none"),
  upstreamAuthName: z.string().trim().min(1).max(100).nullable().optional(),
  // Write-only. Admin responses expose only upstreamAuthConfigured.
  upstreamAuthSecret: z.string().min(1).max(8192).nullable().optional(),
  enabled: z.boolean().default(true)
};

export const AdminMcpServerCreateRequestSchema = z.object({
  serverId: AdminIdSchema,
  ...AdminMcpServerMutationFields
});
export type AdminMcpServerCreateRequest = z.input<typeof AdminMcpServerCreateRequestSchema>;

export const AdminMcpServerUpdateRequestSchema = z.object({
  serverId: AdminIdSchema.optional(),
  ...AdminMcpServerMutationFields
}).extend({
  // Omission preserves the existing write-only authentication configuration.
  upstreamAuthType: z.enum(["none", "bearer", "header", "query"]).optional()
});
export type AdminMcpServerUpdateRequest = z.input<typeof AdminMcpServerUpdateRequestSchema>;

export const AdminMcpServersListResponseSchema = z.object({
  mcpServers: z.array(AdminMcpServerSchema)
}).passthrough();
export type AdminMcpServersListResponse = z.infer<typeof AdminMcpServersListResponseSchema>;

export const AdminMcpServerEnvelopeSchema = z.object({
  mcpServer: AdminMcpServerSchema
}).passthrough();
export type AdminMcpServerEnvelope = z.infer<typeof AdminMcpServerEnvelopeSchema>;
