// The request body of `PUT /admin/tenant-settings`. It is a separate entry
// point (`@cogniplane/shared-types/tenant-settings-request`) because the
// sandbox host check loads a public suffix list. A type-only import adds
// nothing to a bundle.
//
// Each key of this schema is one tenant setting, except `expectedVersion`.
// `TenantSettingsField` is that key set. The backend types its field lists
// (step-up classification, audit payload, Admin History comparison) as
// `Record<TenantSettingsField, ...>`, so a new setting fails the build until
// each list has it.

import { z } from "zod";

import { AdminIdSchema } from "./schemas/_helpers.js";
import { PolicyEnforcementModeSchema } from "./schemas/policy.js";
import { ApprovalPolicySchema, ApprovalReviewerSchema, WebSearchModeSchema } from "./schemas/tenant.js";
import { DEVELOPER_INSTRUCTIONS_MAX_LENGTH, EFFORT_LEVELS, MODEL_PROVIDERS } from "./primitives.js";
import { SandboxEgressDomainsSchema } from "./sandbox-egress.js";

export const TenantSettingsUpdateRequestSchema = z.object({
  // The settings version that the change is based on. A save from another
  // version gets 409.
  expectedVersion: z.number().int().nonnegative().optional(),
  showEffortSelector: z.boolean().optional(),
  webSearchMode: WebSearchModeSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  approvalReviewer: ApprovalReviewerSchema.optional(),
  allowCommandExecution: z.boolean().optional(),
  autoApproveReadOnlyTools: z.boolean().optional(),
  policyEnforcementMode: PolicyEnforcementModeSchema.optional(),
  developerInstructions: z.string().trim().max(DEVELOPER_INSTRUCTIONS_MAX_LENGTH).nullable().optional(),
  enabledToolIds: z.array(AdminIdSchema).optional(),
  enabledMcpServerIds: z.array(AdminIdSchema).optional(),
  // Model ids have a catalog namespace ("openrouter/z-ai/..."), so this checks
  // only a bounded string. The route checks each id against the catalog.
  enabledProviders: z.array(z.enum(MODEL_PROVIDERS)).optional(),
  enabledModelIds: z.array(z.string().trim().min(1).max(200)).nullable().optional(),
  defaultModelId: z.string().trim().min(1).max(200).nullable().optional(),
  modelDefaultEfforts: z.record(z.string().trim().min(1).max(200), z.enum(EFFORT_LEVELS)).optional(),
  // Hosts that agent-run code in the sandbox may reach. The provider checks
  // nothing, so this is the check: exact host names, with `*.` only over a
  // name that one party registers. An empty list means no network.
  approvedSandboxEgressDomains: SandboxEgressDomainsSchema.optional()
});

/** What a client sends (before trimming). */
export type TenantSettingsUpdateRequest = z.input<typeof TenantSettingsUpdateRequestSchema>;
/** What the route reads after the parse. */
export type TenantSettingsUpdate = z.output<typeof TenantSettingsUpdateRequestSchema>;

/** One tenant setting: a request key other than `expectedVersion`. */
export type TenantSettingsField = Exclude<keyof TenantSettingsUpdate, "expectedVersion">;

/** Every tenant setting, in request schema order. */
export const TENANT_SETTINGS_FIELD_NAMES = Object.keys(TenantSettingsUpdateRequestSchema.shape)
  .filter((key): key is TenantSettingsField => key !== "expectedVersion");
