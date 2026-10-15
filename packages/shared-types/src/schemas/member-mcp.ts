import { z } from "zod";
import { IsoDateSchema } from "./_helpers.js";

export const McpCredentialScopeSchema = z.object({ tenantId: z.string().min(1), userId: z.string().min(1) }).strict();
export const McpCredentialStatusSchema = z.object({
  status: z.enum(["not_connected", "connected", "reconnect_required", "organization", "no_auth", "unavailable"]),
  credentialVersion: z.number().int().nonnegative(),
  accountLabel: z.string().nullable()
});
export type McpCredentialStatus = z.infer<typeof McpCredentialStatusSchema>;
export const McpConnectionSchema = McpCredentialStatusSchema.extend({
  serverId: z.string(), serverName: z.string(), description: z.string().nullable(),
  upstreamUrl: z.string().nullable(), authType: z.enum(["none", "bearer", "header", "query"]),
  authName: z.string().nullable(), credentialScope: z.enum(["organization", "personal"]),
  serverVersion: z.number().int().nonnegative(), canConnect: z.boolean(),
  hasCredential: z.boolean().default(false),
  updatedAt: IsoDateSchema.nullable().optional()
});
export type McpConnection = z.infer<typeof McpConnectionSchema>;
export const MemberMcpConnectionsResponseSchema = z.object({
  scope: McpCredentialScopeSchema, connections: z.array(McpConnectionSchema)
});
export const MemberMcpConnectionResponseSchema = z.object({ scope: McpCredentialScopeSchema, connection: McpConnectionSchema });
export const MemberMcpCredentialSaveSchema = z.object({
  scope: McpCredentialScopeSchema, version: z.number().int().nonnegative(),
  serverVersion: z.number().int().positive(), secret: z.string().min(8).max(8192).refine(value => !/[\r\n]/.test(value) && !value.includes("\0"), "Credentials cannot contain line breaks or null characters."),
  accountLabel: z.string().trim().max(120).nullable()
}).strict();
export type MemberMcpCredentialSave = z.infer<typeof MemberMcpCredentialSaveSchema>;
export const MemberMcpCredentialRemoveSchema = z.object({ scope: McpCredentialScopeSchema, version: z.number().int().nonnegative() }).strict();
export type MemberMcpCredentialRemove = z.infer<typeof MemberMcpCredentialRemoveSchema>;
export const MemberMcpCredentialRemoveResponseSchema = z.object({ scope: McpCredentialScopeSchema, removed: z.literal(true) });
