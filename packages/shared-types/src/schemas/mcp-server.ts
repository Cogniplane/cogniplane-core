import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

export const AdminMcpServerSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  description: z.string().nullable(),
  transportKind: z.literal("http"),
  mode: z.enum(["managed", "proxy"]),
  routePath: z.string(),
  upstreamUrl: z.string().nullable(),
  headersAllowlist: z.array(z.string()),
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

export const AdminMcpServersListResponseSchema = z.object({
  mcpServers: z.array(AdminMcpServerSchema)
}).passthrough();
export type AdminMcpServersListResponse = z.infer<typeof AdminMcpServersListResponseSchema>;

export const AdminMcpServerEnvelopeSchema = z.object({
  mcpServer: AdminMcpServerSchema
}).passthrough();
export type AdminMcpServerEnvelope = z.infer<typeof AdminMcpServerEnvelopeSchema>;
