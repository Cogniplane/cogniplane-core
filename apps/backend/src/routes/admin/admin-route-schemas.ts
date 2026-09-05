import { z } from "zod";
import {
  AdminMcpServerCreateRequestSchema,
  AdminMcpServerUpdateRequestSchema,
  EFFORT_LEVELS,
  MODEL_PROVIDERS,
  PolicyEnforcementModeSchema
} from "@cogniplane/shared-types";

import { httpsUrlSchema } from "../../lib/url-validation.js";

import { adminIdSchema } from "./admin-route-helpers.js";

export const mcpCreateBodySchema = AdminMcpServerCreateRequestSchema.extend({
  upstreamUrl: httpsUrlSchema.nullable().optional()
});

export const mcpUpdateBodySchema = AdminMcpServerUpdateRequestSchema.extend({
  upstreamUrl: httpsUrlSchema.nullable().optional()
});

const granularApprovalPolicySchema = z.object({
  granular: z.object({
    sandbox_approval: z.boolean(),
    mcp_elicitations: z.boolean(),
    rules: z.boolean(),
    request_permissions: z.boolean().optional(),
    skill_approval: z.boolean().optional()
  })
});

export const tenantSettingsBodySchema = z.object({
  showEffortSelector: z.boolean().optional(),
  webSearchMode: z.enum(["disabled", "cached", "live"]).optional(),
  approvalPolicy: z.union([z.enum(["never", "on-request"]), granularApprovalPolicySchema]).optional(),
  approvalReviewer: z.enum(["user", "guardian_subagent"]).optional(),
  allowCommandExecution: z.boolean().optional(),
  autoApproveReadOnlyTools: z.boolean().optional(),
  policyEnforcementMode: PolicyEnforcementModeSchema.optional(),
  developerInstructions: z.string().trim().max(4000).nullable().optional(),
  enabledToolIds: z.array(adminIdSchema).optional(),
  enabledMcpServerIds: z.array(adminIdSchema).optional(),
  // Model availability. Model ids are catalog-namespaced ("openrouter/z-ai/…"),
  // so a plain bounded string — semantic validation against AVAILABLE_MODELS
  // happens in the route, where the catalog is in scope.
  enabledProviders: z.array(z.enum(MODEL_PROVIDERS)).optional(),
  enabledModelIds: z.array(z.string().trim().min(1).max(200)).nullable().optional(),
  modelDefaultEfforts: z.record(z.string().trim().min(1).max(200), z.enum(EFFORT_LEVELS)).optional()
});

export const githubImportBodySchema = z.object({
  githubUrl: httpsUrlSchema,
  ref: z.string().trim().min(1).max(200).optional(),
  subdirectory: z.string().trim().min(1).max(300).optional()
});

// Display name for an inline skill. Allows human-readable text (letters,
// digits, spaces, common punctuation) but forbids path separators and control
// characters as defense-in-depth — even though workspace filenames now key on
// the validated skillId, the name should never be able to carry a `/` or a
// traversal sequence into any downstream filesystem path.
const inlineSkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // Forbid path separators (`/`, `\\`) and control characters (NUL, newlines,
  // etc.). Spaces and ordinary punctuation stay allowed so a name like
  // "PDF Processing" remains valid.
  // eslint-disable-next-line no-control-regex
  .regex(/^[^/\\\u0000-\u001f]+$/, {
    message: "skillName must not contain path separators or control characters."
  });

export const inlineSkillImportBodySchema = z.object({
  skillId: adminIdSchema,
  skillName: inlineSkillNameSchema,
  description: z.string().trim().min(1).max(1024),
  instructions: z.string().min(1).max(200_000)
});

export const skillRevisionParamsSchema = z.object({
  skillId: adminIdSchema,
  skillRevisionId: z.coerce.number().int().positive()
});

export const cleanupSkillRevisionsBodySchema = z
  .object({
    dryRun: z.boolean().optional()
  })
  .optional();

export const activateSkillRevisionBodySchema = z.object({
  reviewNotes: z.string().trim().max(1000).nullable().optional()
});

export const rolloutBodySchema = z.object({
  action: z.enum(["drain_idle", "refresh_idle"])
});

const sessionStatusSchema = z.enum(["active", "errored"]);

const sessionAlertSchema = z.enum([
  "pii-blocked",
  "pii-transformed",
  "pii-detected",
  "approval-rejected",
  "approval-pending",
  "errored"
]);

const optionalIsoDate = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    { message: "Must be a valid ISO-8601 timestamp." }
  )
  .optional();

const commaSeparatedAlerts = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const parts = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "alert must be non-empty." });
      return z.NEVER;
    }
    const validated: z.infer<typeof sessionAlertSchema>[] = [];
    for (const part of parts) {
      const result = sessionAlertSchema.safeParse(part);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown alert kind: ${part}`
        });
        return z.NEVER;
      }
      validated.push(result.data);
    }
    return Array.from(new Set(validated));
  })
  .optional();

const limitSchema = z
  .string()
  .optional()
  .transform((value) => {
    const parsed = parseInt(value ?? "50", 10);
    if (!Number.isFinite(parsed)) return 50;
    return Math.min(Math.max(parsed, 1), 200);
  });

export const adminSessionsListQuerySchema = z.object({
  userId: z.string().trim().min(1).max(120).optional(),
  from: optionalIsoDate,
  to: optionalIsoDate,
  status: sessionStatusSchema.optional(),
  alert: commaSeparatedAlerts,
  cursor: z.string().trim().min(1).optional(),
  limit: limitSchema
});
