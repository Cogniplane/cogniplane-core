import { z } from "zod";
import { IsoDateSchema } from "./_helpers.js";

export const PersonalSkillScopeSchema = z.object({
  tenantId: z.string().min(1), userId: z.string().min(1)
}).strict();
export type PersonalSkillScope = z.infer<typeof PersonalSkillScopeSchema>;

export const PersonalSkillContentSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
  instructions: z.string().trim().min(1).max(64000)
}).strict();
export type PersonalSkillContent = z.infer<typeof PersonalSkillContentSchema>;

export const PersonalSkillSourceSchema = z.discriminatedUnion("kind", [
  PersonalSkillContentSchema.extend({ kind: z.literal("inline") }),
  z.object({ kind: z.literal("markdown"), markdown: z.string().min(1).max(128000) }).strict()
]);
export type PersonalSkillSource = z.infer<typeof PersonalSkillSourceSchema>;

export const PersonalSkillRevisionSchema = z.object({
  revision: z.number().int().positive(),
  content: PersonalSkillContentSchema,
  validationMessages: z.array(z.string()),
  createdAt: IsoDateSchema
});
export type PersonalSkillRevision = z.infer<typeof PersonalSkillRevisionSchema>;

export const PersonalSkillSchema = z.object({
  id: z.string(), version: z.number().int().positive(), enabled: z.boolean(),
  latest: PersonalSkillRevisionSchema,
  active: PersonalSkillRevisionSchema.nullable(), updatedAt: IsoDateSchema
});
export type PersonalSkill = z.infer<typeof PersonalSkillSchema>;

export const PersonalSkillsResponseSchema = z.object({
  scope: PersonalSkillScopeSchema, skills: z.array(PersonalSkillSchema)
});
export type PersonalSkillsResponse = z.infer<typeof PersonalSkillsResponseSchema>;
export const PersonalSkillResponseSchema = z.object({
  scope: PersonalSkillScopeSchema, skill: PersonalSkillSchema
});
export const PersonalSkillHistoryResponseSchema = z.object({
  scope: PersonalSkillScopeSchema, revisions: z.array(PersonalSkillRevisionSchema)
});
export const PersonalSkillCreateSchema = z.object({
  scope: PersonalSkillScopeSchema, source: PersonalSkillSourceSchema
}).strict();
export type PersonalSkillCreate = z.infer<typeof PersonalSkillCreateSchema>;
export const PersonalSkillUpdateSchema = PersonalSkillCreateSchema.extend({ version: z.number().int().positive() });
export type PersonalSkillUpdate = z.infer<typeof PersonalSkillUpdateSchema>;
export const PersonalSkillActionSchema = z.object({
  scope: PersonalSkillScopeSchema, version: z.number().int().positive(),
  action: z.enum(["release", "disable"])
}).strict();
export type PersonalSkillAction = z.infer<typeof PersonalSkillActionSchema>;
export const PersonalSkillDeleteSchema = PersonalSkillActionSchema.omit({ action: true });
export const PersonalSkillDeleteResponseSchema = z.object({ scope: PersonalSkillScopeSchema, deleted: z.literal(true) });
