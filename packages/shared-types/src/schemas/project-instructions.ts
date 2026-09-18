import { z } from "zod";

export const MAX_PROJECT_INSTRUCTIONS_LENGTH = 12_000;
export const ProjectInstructionsTextSchema = z.string().trim().max(MAX_PROJECT_INSTRUCTIONS_LENGTH);
export const ProjectInstructionsUpdateSchema = z.object({
  instructions: ProjectInstructionsTextSchema,
  expectedRevision: z.number().int().nonnegative()
}).strict();
export const ProjectInstructionsSnapshotSchema = z.object({
  projectId: z.string(),
  revision: z.number().int().nonnegative(),
  instructions: z.string()
});
export type ProjectInstructionsSnapshot = z.infer<typeof ProjectInstructionsSnapshotSchema>;

export const ProjectInstructionsStatusSchema = z.object({
  projectId: z.string(),
  hasInstructions: z.boolean(),
  instructionsRevision: z.number().int().nonnegative()
});
export type ProjectInstructionsStatus = z.infer<typeof ProjectInstructionsStatusSchema>;
