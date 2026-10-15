import { z } from "zod";

export const AdminSkillReleaseSnapshotSchema = z.object({
  version: z.number().int().nonnegative(),
  activeRevisionId: z.number().int().positive().nullable(),
  latestRevisionId: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  isPublished: z.boolean()
}).strict();
export type AdminSkillReleaseSnapshot = z.infer<typeof AdminSkillReleaseSnapshotSchema>;
export const AdminSkillReleaseSnapshotRequestSchema = z.object({
  expectedSnapshot: AdminSkillReleaseSnapshotSchema
}).strict();

export const AdminSkillReleaseImpactRequestSchema = z.object({
  action: z.enum(["activate", "audience"]),
  revisionId: z.number().int().positive().nullable(),
  audience: z.enum(["off", "test-users", "members"])
}).strict().superRefine((value, context) => {
  if (value.action === "activate" && (value.revisionId === null || value.audience === "off")) {
    context.addIssue({code:"custom",message:"Activation needs a revision and an audience."});
  }
});
const state = z.object({
  revisionId: z.number().int().positive().nullable(),
  revisionNumber: z.number().int().positive().nullable(),
  audience: z.enum(["off", "test-users", "members"])
});
const references = z.object({
  inherited: z.number().int().nonnegative(), explicitSelected: z.number().int().nonnegative()
});
export const AdminSkillReleaseImpactResponseSchema = z.object({
  skillId: z.string(), snapshot: AdminSkillReleaseSnapshotSchema,
  current: state, proposed: state,
  members: z.object({total:z.number().int().nonnegative(),testUsers:z.number().int().nonnegative(),
    gaining:z.number().int().nonnegative(),losing:z.number().int().nonnegative()}),
  configuredReferences: z.object({projects:references,personalDefaults:references,sessions:references})
});
export type AdminSkillReleaseImpact = z.infer<typeof AdminSkillReleaseImpactResponseSchema>;
