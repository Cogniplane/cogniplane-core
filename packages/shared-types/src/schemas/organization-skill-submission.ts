import { z } from "zod";
import { IsoDateSchema } from "./_helpers.js";
import { PersonalSkillContentSchema, PersonalSkillScopeSchema } from "./personal-skill.js";
import { AdminSkillReleaseSnapshotSchema } from "./admin-skill-release-impact.js";

export const OrganizationSkillSubmissionStatusSchema = z.enum([
  "pending", "changes_requested", "declined", "withdrawn", "accepted"
]);
export const OrganizationSkillSubmissionSnapshotSchema = z.object({
  content: PersonalSkillContentSchema,
  sourceRevision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  validationMessages: z.array(z.string())
});
export const OrganizationSkillSubmissionAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  status: OrganizationSkillSubmissionStatusSchema,
  note: z.string(),
  snapshot: OrganizationSkillSubmissionSnapshotSchema,
  submittedAt: IsoDateSchema,
  decidedAt: IsoDateSchema.nullable(),
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  feedback: z.string().nullable(),
  acceptedRevisionId: z.number().int().positive().nullable()
});
export const OrganizationSkillSubmissionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  status: OrganizationSkillSubmissionStatusSchema,
  authorUserId: z.string(),
  authorName: z.string(),
  authorEmail: z.string().nullable(),
  sourceSkillId: z.string(),
  targetOrganizationSkillId: z.string().nullable(),
  acceptedOrganizationSkillId: z.string().nullable(),
  latest: OrganizationSkillSubmissionAttemptSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});
export const OrganizationSkillSubmissionDetailSchema = OrganizationSkillSubmissionSchema.extend({
  attempts: z.array(OrganizationSkillSubmissionAttemptSchema),
  updates: z.array(z.lazy(() => OrganizationSkillSubmissionUpdateSchema)),
  organizationSkill: z.object({
    skillId: z.string(), version: z.number(), enabled: z.boolean(), isPublished: z.boolean(),
    activeRevisionId: z.number().nullable(),
    currentDraftRevisionId: z.number().nullable(),
    activeContent: z.object({ name: z.string(), description: z.string(), instructions: z.string() }).nullable(),
    currentDraftContent: z.object({ name: z.string(), description: z.string(), instructions: z.string() }).nullable()
  }).nullable()
});
export const OrganizationSkillSubmissionUpdateSchema = z.object({
  id: z.string().uuid(), submissionId: z.string().uuid(), attempt: z.number().int().positive(),
  kind: z.enum(["changes_requested", "declined", "accepted", "released"]),
  skillName: z.string(), feedback: z.string().nullable(),
  organizationSkillId: z.string().nullable(), organizationRevisionId: z.number().int().positive().nullable(),
  audience: z.enum(["test-users", "members"]).nullable(),
  createdAt: IsoDateSchema, readAt: IsoDateSchema.nullable()
});
export type OrganizationSkillSubmissionUpdate = z.infer<typeof OrganizationSkillSubmissionUpdateSchema>;
export const OrganizationSkillSubmissionUpdatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20), before: z.string().uuid().optional()
}).strict();
export const OrganizationSkillSubmissionUpdatesResponseSchema = z.object({
  scope: PersonalSkillScopeSchema, updates: z.array(OrganizationSkillSubmissionUpdateSchema),
  unreadCount: z.number().int().nonnegative(), nextCursor: z.string().uuid().nullable()
});
export const OrganizationSkillSubmissionUpdateReadSchema = z.object({ scope: PersonalSkillScopeSchema }).strict();
export const OrganizationSkillSubmissionUpdateReadResponseSchema = z.object({
  scope: PersonalSkillScopeSchema, id: z.string().uuid(), readAt: IsoDateSchema,
  unreadCount: z.number().int().nonnegative()
});
export type OrganizationSkillSubmission = z.infer<typeof OrganizationSkillSubmissionSchema>;
export type OrganizationSkillSubmissionDetail = z.infer<typeof OrganizationSkillSubmissionDetailSchema>;
export const OrganizationSkillSubmissionsResponseSchema = z.object({
  scope: PersonalSkillScopeSchema, submissions: z.array(OrganizationSkillSubmissionSchema)
});
export const OrganizationSkillSubmissionResponseSchema = z.object({
  scope: PersonalSkillScopeSchema, submission: OrganizationSkillSubmissionDetailSchema
});
export const OrganizationSkillSubmissionCreateSchema = z.object({
  scope: PersonalSkillScopeSchema,
  personalSkillId: z.string().regex(/^personal-skill-[0-9a-f-]{36}$/),
  sourceRevision: z.number().int().positive(),
  note: z.string().trim().max(4000).default(""),
  targetOrganizationSkillId: z.string().min(1).max(128).nullable().default(null)
}).strict();
export const OrganizationSkillSubmissionVersionSchema = z.object({
  scope: PersonalSkillScopeSchema, version: z.number().int().positive()
}).strict();
export const OrganizationSkillSubmissionResubmitSchema = OrganizationSkillSubmissionVersionSchema.extend({
  sourceRevision: z.number().int().positive(), note: z.string().trim().max(4000).default("")
});
export const OrganizationSkillSubmissionDecisionSchema = OrganizationSkillSubmissionVersionSchema.extend({
  action: z.enum(["request_changes", "decline", "accept"]),
  reason: z.string().trim().max(4000).nullable().default(null),
  organizationSkillId: z.string().min(1).max(128).nullable().default(null),
  organizationSkillName: z.string().trim().min(1).max(64).nullable().default(null),
  expectedOrganizationVersion: z.number().int().nonnegative().nullable().default(null)
});
export const OrganizationSkillSubmissionReleaseSchema = z.object({
  scope: PersonalSkillScopeSchema,
  expectedOrganizationVersion: z.number().int().nonnegative(),
  expectedActiveRevisionId: z.number().int().positive().nullable(),
  expectedDraftRevisionId: z.number().int().positive(),
  audience: z.enum(["test-users", "members"]),
  expectedSnapshot: AdminSkillReleaseSnapshotSchema.optional()
}).strict();
