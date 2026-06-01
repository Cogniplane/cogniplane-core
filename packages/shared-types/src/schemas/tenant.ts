import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

import { PiiProtectionSettingsSchema } from "./pii.js";
import { PolicyEnforcementModeSchema } from "./policy.js";

import { WEB_SEARCH_MODES } from "../primitives.js";

// Granular approval policy + literal forms must mirror @cogniplane/shared-types primitive types.
const GranularApprovalPolicySchema = z.object({
  granular: z.object({
    sandbox_approval: z.boolean(),
    mcp_elicitations: z.boolean(),
    rules: z.boolean(),
    request_permissions: z.boolean().optional(),
    skill_approval: z.boolean().optional()
  }).passthrough()
}).passthrough();

const ApprovalPolicySchema = z.union([
  z.literal("never"),
  z.literal("on-request"),
  GranularApprovalPolicySchema
]);

const ApprovalReviewerSchema = z.enum(["user", "guardian_subagent"]);

const RuntimeProviderSchema = z.enum(["codex", "claude-code"]);

const WebSearchModeSchema = z.enum(WEB_SEARCH_MODES);

export const TenantSettingsSchema = z.object({
  tenantId: z.string(),
  runtimeProvider: RuntimeProviderSchema,
  enabledRuntimeProviders: z.array(RuntimeProviderSchema),
  showEffortSelector: z.boolean(),
  webSearchMode: WebSearchModeSchema,
  approvalPolicy: ApprovalPolicySchema,
  approvalReviewer: ApprovalReviewerSchema,
  allowCommandExecution: z.boolean(),
  allowUserTokenForwarding: z.boolean(),
  autoApproveReadOnlyTools: z.boolean(),
  // Tenant-level Policy Center switch. monitor: rules are evaluated and decisions
  // recorded, but no action is gated. enforce: matching block/require_approval
  // rules actually gate. The natural rollout is monitor → watch decisions →
  // enforce. Default monitor so Policy Center is inert until deliberately armed.
  policyEnforcementMode: PolicyEnforcementModeSchema,
  developerInstructions: z.string().nullable(),
  enabledToolIds: z.array(z.string()),
  enabledMcpServerIds: z.array(z.string()),
  version: z.number(),
  configHash: z.string(),
  updatedAt: IsoDateSchema
}).passthrough();
export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

export const TenantSettingsEnvelopeSchema = z.object({
  settings: TenantSettingsSchema
}).passthrough();
export type TenantSettingsEnvelope = z.infer<typeof TenantSettingsEnvelopeSchema>;

export const ManagedToolDescriptorSchema = z.object({
  id: z.string(),
  description: z.string(),
  readOnly: z.boolean()
}).passthrough();
export type ManagedToolDescriptor = z.infer<typeof ManagedToolDescriptorSchema>;

export const ManagedToolsListResponseSchema = z.object({
  tools: z.array(ManagedToolDescriptorSchema)
}).passthrough();
export type ManagedToolsListResponse = z.infer<typeof ManagedToolsListResponseSchema>;

export const TenantDetailsSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  slug: z.string(),
  ssoProvider: z.string().nullable(),
  plan: z.string(),
  settings: z.object({
    openaiApiKeyConfigured: z.boolean(),
    anthropicApiKeyConfigured: z.boolean(),
    skillMarketplaceManifestUrl: z.string().nullable(),
    piiProtection: PiiProtectionSettingsSchema,
    github: z.object({
      configured: z.boolean()
    }).passthrough(),
    microsoftOAuth: z.object({
      configured: z.boolean()
    }).passthrough()
  }).passthrough(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).passthrough();
export type TenantDetails = z.infer<typeof TenantDetailsSchema>;

// ── Tenant settings update responses (PUT /tenant/settings/*) ───────────────
//
// Each settings PUT returns `{ ok, ... }` with the relevant flag echoed back.
// Shared so frontend and backend agree on the wire shape.

export const TenantOpenAiKeyUpdateResponseSchema = z.object({
  ok: z.boolean(),
  openaiApiKeyConfigured: z.boolean()
}).passthrough();
export type TenantOpenAiKeyUpdateResponse = z.infer<typeof TenantOpenAiKeyUpdateResponseSchema>;

export const TenantAnthropicKeyUpdateResponseSchema = z.object({
  ok: z.boolean(),
  anthropicApiKeyConfigured: z.boolean()
}).passthrough();
export type TenantAnthropicKeyUpdateResponse = z.infer<typeof TenantAnthropicKeyUpdateResponseSchema>;

export const TenantMarketplaceManifestUrlUpdateResponseSchema = z.object({
  ok: z.boolean(),
  skillMarketplaceManifestUrl: z.string().nullable()
}).passthrough();
export type TenantMarketplaceManifestUrlUpdateResponse = z.infer<typeof TenantMarketplaceManifestUrlUpdateResponseSchema>;

export const TenantPiiProtectionUpdateResponseSchema = z.object({
  ok: z.boolean(),
  piiProtection: PiiProtectionSettingsSchema
}).passthrough();
export type TenantPiiProtectionUpdateResponse = z.infer<typeof TenantPiiProtectionUpdateResponseSchema>;

export const TenantOkResponseSchema = z.object({
  ok: z.boolean()
}).passthrough();
export type TenantOkResponse = z.infer<typeof TenantOkResponseSchema>;
