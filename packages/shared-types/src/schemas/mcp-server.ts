import { z } from "zod";

import { CSP_SOURCE_MAX_LENGTH, MCP_APP_CSP_DIRECTIVES } from "../mcp-app-csp.js";
import { AdminIdSchema, IsoDateSchema } from "./_helpers.js";

export const AdminMcpConnectionTestSchema = z.object({
  serverId: z.string(),
  configVersion: z.number().int().positive(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: IsoDateSchema,
  credentialScope: z.enum(["organization", "personal"]),
  testedUserId: z.string().nullable(),
  reachability: z.enum(["reachable", "unreachable", "unknown"]),
  authentication: z.enum(["accepted", "not_required", "indeterminate", "credential_missing"]),
  toolDiscovery: z.enum(["succeeded", "partial", "failed", "not_tested"]),
  toolCount: z.number().int().nonnegative().nullable(),
  message: z.string()
});
export type AdminMcpConnectionTest = z.infer<typeof AdminMcpConnectionTestSchema>;
export const AdminMcpConnectionTestRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedConfigHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const AdminMcpConnectionTestResponseSchema = z.object({
  connectionTest: AdminMcpConnectionTestSchema
});

export const AdminMcpServerSchema = z.object({
  serverId: z.string(),
  ownerTenantId: z.string().optional(),
  serverName: z.string(),
  description: z.string().nullable(),
  transportKind: z.literal("http"),
  mode: z.enum(["managed", "proxy"]),
  routePath: z.string(),
  upstreamUrl: z.string().nullable(),
  upstreamAuthType: z.enum(["none", "bearer", "header", "query"]),
  upstreamAuthName: z.string().nullable(),
  upstreamAuthConfigured: z.boolean(),
  credentialScope: z.enum(["organization", "personal"]).optional(),
  credentialBindingId: z.string().optional(),
  version: z.number(),
  configHash: z.string(),
  enabled: z.boolean(),
  isPublished: z.boolean(),
  isAllowed: z.boolean().optional(),
  createdBy: z.string(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  invokedSessions30d: z.number().optional(),
  materializedSessions30d: z.number().optional(),
  connectionTest: AdminMcpConnectionTestSchema.nullable().optional()
}).passthrough();
export type AdminMcpServer = z.infer<typeof AdminMcpServerSchema>;

const AdminMcpServerMutationFields = {
  serverName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  transportKind: z.literal("http").default("http"),
  mode: z.enum(["managed", "proxy"]),
  routePath: z.string().trim().min(1).max(200),
  // Backend routes accept local HTTP URLs for proxy mode and reject URL credentials.
  upstreamUrl: z.string().url().nullable().optional(),
  upstreamAuthType: z.enum(["none", "bearer", "header", "query"]).default("none"),
  credentialScope: z.enum(["organization", "personal"]).default("organization"),
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
  upstreamAuthType: z.enum(["none", "bearer", "header", "query"]).optional(),
  credentialScope: z.enum(["organization", "personal"]).optional()
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

export const McpAppCspDirectiveSchema = z.enum(MCP_APP_CSP_DIRECTIVES);

/**
 * The content security policy sources of one proxy server's widgets. An
 * administrator approves a source for one source list of one server.
 * `requested` is what its widgets declared when members opened them.
 */
export const AdminMcpWidgetDomainsSchema = z.object({
  serverId: z.string(),
  approved: z.array(z.object({
    directive: McpAppCspDirectiveSchema,
    source: z.string(),
    approvedBy: z.string(),
    approvedAt: IsoDateSchema
  })),
  requested: z.array(z.object({
    directive: McpAppCspDirectiveSchema,
    source: z.string(),
    firstSeenAt: IsoDateSchema,
    lastSeenAt: IsoDateSchema
  }))
});
export type AdminMcpWidgetDomains = z.infer<typeof AdminMcpWidgetDomainsSchema>;
export const AdminMcpWidgetDomainsResponseSchema = z.object({
  widgetDomains: AdminMcpWidgetDomainsSchema
});

export const AdminMcpWidgetDomainChangeRequestSchema = z.object({
  directive: McpAppCspDirectiveSchema,
  source: z.string().trim().min(1).max(CSP_SOURCE_MAX_LENGTH)
}).strict();
export type AdminMcpWidgetDomainChangeRequest = z.infer<typeof AdminMcpWidgetDomainChangeRequestSchema>;
