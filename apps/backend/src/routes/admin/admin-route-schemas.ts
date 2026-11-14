import { z } from "zod";
import {
  AdminMcpServerCreateRequestSchema,
  AdminMcpServerUpdateRequestSchema,
  AdminSkillReleaseSnapshotSchema
} from "@cogniplane/shared-types";

import { httpsUrlSchema, mcpUpstreamUrlSchema } from "../../lib/url-validation.js";

import { adminIdSchema } from "./admin-route-helpers.js";

export const mcpCreateBodySchema = AdminMcpServerCreateRequestSchema.extend({
  upstreamUrl: mcpUpstreamUrlSchema.nullable().optional()
}).refine((body) => body.mode === "proxy" || !body.upstreamUrl, {
  path: ["upstreamUrl"],
  message: "Managed MCP servers cannot configure an upstreamUrl"
});

export const mcpUpdateBodySchema = AdminMcpServerUpdateRequestSchema.extend({
  upstreamUrl: mcpUpstreamUrlSchema.nullable().optional()
}).refine((body) => body.mode === "proxy" || !body.upstreamUrl, {
  path: ["upstreamUrl"],
  message: "Managed MCP servers cannot configure an upstreamUrl"
});

// The request schema lives in shared-types, so the frontend sends the same
// shape. This name stays for the route and its tests.
export { TenantSettingsUpdateRequestSchema as tenantSettingsBodySchema } from "@cogniplane/shared-types/tenant-settings-request";

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
  // Matches the SKILL.md name limit and organization_skill_author_updates.skill_name.
  .max(64)
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
  audience: z.enum(["test-users", "members"]).optional(),
  reviewNotes: z.string().trim().max(1000).nullable().optional(),
  expectedSnapshot: AdminSkillReleaseSnapshotSchema
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
