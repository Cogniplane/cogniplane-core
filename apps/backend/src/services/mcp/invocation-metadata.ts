// Trusted per-call values that the backend runtime sends with an MCP
// `tools/call`. They travel in `params._meta`, not in the tool arguments, so a
// strict tool schema stays valid and the model never sees or writes them.
//
// The values select which tool context and which approval the gateway checks.
// They grant nothing themselves. The gateway still binds the context to the
// runtime token. It binds the approval to the session, user, tool, server,
// context and canonical arguments, and claims it once.

import { z } from "zod";

/** The `params._meta` key for backend invocation values. */
export const MCP_INVOCATION_META_KEY = "cogniplane.ai/invocation";

export type McpInvocationMetadata = {
  toolContextId?: string;
  policyApprovalId?: string;
};

const invocationMetadataSchema = z.strictObject({
  toolContextId: z.string().regex(/^ctx_[\w-]{1,200}$/).optional(),
  policyApprovalId: z.string().regex(/^polapr_[\w-]{1,200}$/).optional()
}).refine(
  // A proof belongs to the tool context that it was made in, so it never travels alone.
  (value) => value.policyApprovalId === undefined || value.toolContextId !== undefined
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the trusted entry of a `tools/call` request. `null` means that the caller
 * sent none. An entry with an unknown field, a wrong type or an approval without
 * its tool context is malformed. The result never repeats the values it rejects.
 */
export function readInvocationMetadata(
  params: Record<string, unknown> | undefined
): { ok: true; metadata: McpInvocationMetadata | null } | { ok: false } {
  const meta = params?._meta;
  if (meta === undefined) return { ok: true, metadata: null };
  if (!isPlainObject(meta)) return { ok: false };
  if (!Object.hasOwn(meta, MCP_INVOCATION_META_KEY)) return { ok: true, metadata: null };
  const parsed = invocationMetadataSchema.safeParse(meta[MCP_INVOCATION_META_KEY]);
  return parsed.success ? { ok: true, metadata: parsed.data } : { ok: false };
}

/** Request params without the trusted entry. Other `_meta` entries stay. */
export function withoutInvocationMetadata(params: Record<string, unknown>): Record<string, unknown> {
  const meta = params._meta;
  if (!isPlainObject(meta) || !Object.hasOwn(meta, MCP_INVOCATION_META_KEY)) return params;
  const { [MCP_INVOCATION_META_KEY]: _trusted, ...otherMeta } = meta;
  const { _meta: _previousMeta, ...rest } = params;
  return Object.keys(otherMeta).length > 0 ? { ...rest, _meta: otherMeta } : rest;
}

/**
 * Request params with `metadata` as the trusted entry. A value that was already
 * there is replaced, and an empty `metadata` removes it. Other `_meta` entries stay.
 */
export function withInvocationMetadata<T extends { _meta?: Record<string, unknown> }>(
  params: T,
  metadata: McpInvocationMetadata | undefined
): T {
  const cleaned = withoutInvocationMetadata(params as Record<string, unknown>) as T;
  if (!metadata || Object.keys(metadata).length === 0) return cleaned;
  return { ...cleaned, _meta: { ...cleaned._meta, [MCP_INVOCATION_META_KEY]: { ...metadata } } };
}
