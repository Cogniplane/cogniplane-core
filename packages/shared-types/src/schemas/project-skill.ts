import { z } from "zod";
import { IsoDateSchema } from "./_helpers.js";
import { PersonalSkillRevisionSchema, PersonalSkillSourceSchema } from "./personal-skill.js";

// Project skills use the same instruction-only content rules as personal skills.
export const ProjectSkillSourceSchema = PersonalSkillSourceSchema;
export type ProjectSkillSource = z.infer<typeof ProjectSkillSourceSchema>;

export const ProjectSkillScopeSchema = z.object({
  tenantId: z.string().min(1), userId: z.string().min(1), projectId: z.string().min(1)
}).strict();
export type ProjectSkillScope = z.infer<typeof ProjectSkillScopeSchema>;

const PersonalSkillIdSchema = z.string().regex(/^personal-skill-[0-9a-f-]{36}$/);

export const ProjectSkillRevisionSchema = PersonalSkillRevisionSchema.extend({
  // Personal revision copied into this project revision. Null for project edits.
  copiedFromRevision: z.number().int().positive().nullable()
});
export type ProjectSkillRevision = z.infer<typeof ProjectSkillRevisionSchema>;

// The source ID is returned only to the member who owns the personal source.
export const ProjectSkillCopiedFromSchema = z.object({
  mine: z.boolean(),
  personalSkillId: PersonalSkillIdSchema.nullable(),
  revision: z.number().int().positive()
});
export type ProjectSkillCopiedFrom = z.infer<typeof ProjectSkillCopiedFromSchema>;

export const ProjectSkillSchema = z.object({
  id: z.string(), version: z.number().int().positive(), enabled: z.boolean(),
  latest: ProjectSkillRevisionSchema, active: ProjectSkillRevisionSchema.nullable(),
  copiedFrom: ProjectSkillCopiedFromSchema.nullable(), updatedAt: IsoDateSchema
});
export type ProjectSkill = z.infer<typeof ProjectSkillSchema>;

export const ProjectSkillsResponseSchema = z.object({
  scope: ProjectSkillScopeSchema, canEdit: z.boolean(), skills: z.array(ProjectSkillSchema)
});
export type ProjectSkillsResponse = z.infer<typeof ProjectSkillsResponseSchema>;
export const ProjectSkillResponseSchema = z.object({ scope: ProjectSkillScopeSchema, skill: ProjectSkillSchema });
export type ProjectSkillResponse = z.infer<typeof ProjectSkillResponseSchema>;
export const ProjectSkillHistoryResponseSchema = z.object({
  scope: ProjectSkillScopeSchema, revisions: z.array(ProjectSkillRevisionSchema)
});
export const ProjectSkillDeleteResponseSchema = z.object({ scope: ProjectSkillScopeSchema, deleted: z.literal(true) });

export const ProjectSkillCreateSchema = z.object({
  scope: ProjectSkillScopeSchema, source: ProjectSkillSourceSchema
}).strict();
export type ProjectSkillCreate = z.infer<typeof ProjectSkillCreateSchema>;
export const ProjectSkillUpdateSchema = ProjectSkillCreateSchema.extend({ version: z.number().int().positive() });
export type ProjectSkillUpdate = z.infer<typeof ProjectSkillUpdateSchema>;
export const ProjectSkillActionSchema = z.object({
  scope: ProjectSkillScopeSchema, version: z.number().int().positive(),
  action: z.enum(["release", "disable"])
}).strict();
export type ProjectSkillAction = z.infer<typeof ProjectSkillActionSchema>;
export const ProjectSkillDeleteSchema = ProjectSkillActionSchema.omit({ action: true });
export type ProjectSkillDelete = z.infer<typeof ProjectSkillDeleteSchema>;

// Copying requires the released personal revision that the member reviewed.
export const ProjectSkillCopySchema = z.object({
  scope: ProjectSkillScopeSchema, personalSkillId: PersonalSkillIdSchema,
  sourceRevision: z.number().int().positive()
}).strict();
export type ProjectSkillCopy = z.infer<typeof ProjectSkillCopySchema>;
export const ProjectSkillSourceUpdateSchema = z.object({
  scope: ProjectSkillScopeSchema, version: z.number().int().positive(),
  sourceRevision: z.number().int().positive()
}).strict();
export type ProjectSkillSourceUpdate = z.infer<typeof ProjectSkillSourceUpdateSchema>;
