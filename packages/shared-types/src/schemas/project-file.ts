import { z } from "zod";
import { IsoDateSchema } from "./_helpers.js";

export const ProjectEntryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !/[\\/]/.test(name) &&
      [...name].every((character) => character.charCodeAt(0) >= 32) &&
      name !== "." &&
      name !== "..",
    "Use a file or folder name without path separators.",
  );
export const ProjectFolderSchema = z.object({
  folderId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  deletedAt: IsoDateSchema.nullable(),
});
export const ProjectFileVersionSchema = z.object({
  versionId: z.string(),
  fileId: z.string(),
  versionNumber: z.number().int().positive(),
  mimeType: z.string(),
  fileSizeBytes: z.number().nonnegative(),
  checksumSha256: z.string(),
  createdBy: z.string(),
  createdAt: IsoDateSchema,
  restoredFromVersionId: z.string().nullable(),
});
export const ProjectFileSchema = z.object({
  fileId: z.string(),
  folderId: z.string().nullable(),
  name: z.string(),
  kind: z.enum(["published", "draft"]),
  targetFileId: z.string().nullable(),
  baseVersionId: z.string().nullable(),
  createdByType: z.enum(["user", "agent"]),
  trashedAt: IsoDateSchema.nullable(),
  updatedAt: IsoDateSchema,
  version: ProjectFileVersionSchema,
});
export const ProjectLibrarySchema = z.object({
  files: z.array(ProjectFileSchema),
  folders: z.array(ProjectFolderSchema),
});
export const ProjectFileCreateSchema = z
  .object({
    artifactId: z.string().uuid(),
    name: ProjectEntryNameSchema,
    folderId: z.string().uuid().nullable().default(null),
    kind: z.enum(["published", "draft"]),
    targetFileId: z.string().uuid().nullable().default(null),
    baseVersionId: z.string().uuid().nullable().default(null),
  })
  .strict()
  .refine(
    (input) =>
      (input.targetFileId === null) === (input.baseVersionId === null) &&
      (input.targetFileId === null || input.kind === "draft"),
    "Updates require a draft, target file, and base version.",
  );
export const ProjectFileLocationSchema = z
  .object({
    name: ProjectEntryNameSchema,
    folderId: z.string().uuid().nullable(),
  })
  .strict();
export type ProjectFile = z.infer<typeof ProjectFileSchema>;
export type ProjectFolder = z.infer<typeof ProjectFolderSchema>;
export type ProjectFileVersion = z.infer<typeof ProjectFileVersionSchema>;
export type ProjectLibrary = z.infer<typeof ProjectLibrarySchema>;
export type ProjectFileCreate = z.infer<typeof ProjectFileCreateSchema>;

export const ProjectFileHistorySchema = z.array(ProjectFileVersionSchema);
