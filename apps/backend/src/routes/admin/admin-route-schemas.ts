import { z } from "zod";

import { httpsUrlSchema } from "../../lib/url-validation.js";

import { adminIdSchema } from "./admin-route-helpers.js";

export const mcpBodySchema = z.object({
  serverId: adminIdSchema.optional(),
  serverName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  transportKind: z.literal("http").default("http"),
  mode: z.enum(["managed", "proxy"]),
  routePath: z.string().trim().min(1).max(200),
  upstreamUrl: httpsUrlSchema.nullable().optional(),
  headersAllowlist: z.array(z.string().trim().min(1).max(120)).default([]),
  enabled: z.boolean().default(true)
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
  enabledRuntimeProviders: z.array(z.enum(["codex", "claude-code"])).min(1).optional(),
  showEffortSelector: z.boolean().optional(),
  approvalPolicy: z.union([z.enum(["never", "on-request"]), granularApprovalPolicySchema]).optional(),
  approvalReviewer: z.enum(["user", "guardian_subagent"]).optional(),
  allowCommandExecution: z.boolean().optional(),
  allowUserTokenForwarding: z.boolean().optional(),
  autoApproveReadOnlyTools: z.boolean().optional(),
  developerInstructions: z.string().trim().max(4000).nullable().optional(),
  enabledToolIds: z.array(adminIdSchema).optional(),
  enabledMcpServerIds: z.array(adminIdSchema).optional()
});

export const githubImportBodySchema = z.object({
  githubUrl: httpsUrlSchema,
  ref: z.string().trim().min(1).max(200).optional(),
  subdirectory: z.string().trim().min(1).max(300).optional()
});

export const inlineSkillImportBodySchema = z.object({
  skillId: adminIdSchema,
  skillName: z.string().trim().min(1).max(200),
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

const sessionRuntimeSchema = z.enum(["codex", "claude-code"]);

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
  runtime: sessionRuntimeSchema.optional(),
  alert: commaSeparatedAlerts,
  cursor: z.string().trim().min(1).optional(),
  limit: limitSchema
});

export type AdminSessionsListQuery = z.infer<typeof adminSessionsListQuerySchema>;
