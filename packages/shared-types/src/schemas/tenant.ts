import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

import { PiiProtectionSettingsSchema } from "./pii.js";
import { PolicyEnforcementModeSchema } from "./policy.js";

import { EFFORT_LEVELS, MODEL_PROVIDERS, WEB_SEARCH_MODES } from "../primitives.js";

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

const WebSearchModeSchema = z.enum(WEB_SEARCH_MODES);

export const TenantSettingsSchema = z.object({
  tenantId: z.string(),
  showEffortSelector: z.boolean(),
  webSearchMode: WebSearchModeSchema,
  approvalPolicy: ApprovalPolicySchema,
  // Reviewer for runtime-native approvals only. Policy Center
  // require_approval is actor confirmation by the initiating user.
  approvalReviewer: ApprovalReviewerSchema,
  allowCommandExecution: z.boolean(),
  autoApproveReadOnlyTools: z.boolean(),
  // Tenant-level Policy Center switch. monitor: rules are evaluated and decisions
  // recorded, but no action is gated. enforce: matching block/require_approval
  // rules actually gate. The natural rollout is monitor → watch decisions →
  // enforce. Default monitor so Policy Center is inert until deliberately armed.
  policyEnforcementMode: PolicyEnforcementModeSchema,
  developerInstructions: z.string().nullable(),
  enabledToolIds: z.array(z.string()),
  enabledMcpServerIds: z.array(z.string()),
  // Model availability (admin-controlled). A model is selectable iff its
  // provider is in enabledProviders AND a key is configured for that provider
  // AND (enabledModelIds is null OR contains the model id). enabledModelIds
  // null means "all catalog models" so newly shipped models appear without an
  // admin action; an explicit array is a strict allowlist.
  enabledProviders: z.array(z.enum(MODEL_PROVIDERS)),
  enabledModelIds: z.array(z.string()).nullable(),
  // Per-model default reasoning effort overriding the catalog default. Applied
  // server-side when a turn omits an explicit effort, and echoed through
  // /models as each model's defaultEffort.
  modelDefaultEfforts: z.record(z.string(), z.enum(EFFORT_LEVELS)),
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
    // Per-provider key-presence map (booleans only — the keys themselves are
    // never returned). Keyed by public ModelProvider id.
    providerKeys: z.record(z.enum(MODEL_PROVIDERS), z.boolean()),
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

// Require both fields so partial or obsolete requests cannot revoke a key.
// Strict requests reject obsolete fields; passthrough responses tolerate server additions.
export const TenantProviderKeyUpdateRequestSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  // An empty string clears the selected provider's stored key.
  apiKey: z.string().max(512)
}).strict();
export type TenantProviderKeyUpdateRequest = z.infer<typeof TenantProviderKeyUpdateRequestSchema>;

export const TenantProviderKeyUpdateResponseSchema = z.object({
  ok: z.boolean(),
  // Full refreshed presence map so the client updates every provider chip.
  providerKeys: z.record(z.enum(MODEL_PROVIDERS), z.boolean())
}).passthrough();
export type TenantProviderKeyUpdateResponse = z.infer<typeof TenantProviderKeyUpdateResponseSchema>;

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
