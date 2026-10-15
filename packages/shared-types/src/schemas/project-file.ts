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
const PageLimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const PageCursorSchema = z.string().min(1).max(2048).optional();
const SearchSchema = z.string().trim().max(255).optional().transform((value) => value || undefined);

export const ProjectLibraryFilesQuerySchema = z.object({
  section: z.enum(["published", "draft", "trash"]),
  folderId: z.string().uuid().optional(),
  q: SearchSchema,
  sort: z.enum(["updated", "name"]).default("updated"),
  limit: PageLimitSchema,
  cursor: PageCursorSchema,
}).strict();
export type ProjectLibraryFilesQuery = z.infer<typeof ProjectLibraryFilesQuerySchema>;

export const ProjectLibraryFileSchema = ProjectFileSchema.extend({
  folderPath: z.string(),
  target: z.object({
    fileId: z.string(),
    name: z.string(),
    currentVersionId: z.string(),
    available: z.boolean(),
  }).nullable(),
});
export type ProjectLibraryFile = z.infer<typeof ProjectLibraryFileSchema>;
export const ProjectLibraryFilesPageSchema = z.object({
  items: z.array(ProjectLibraryFileSchema),
  nextCursor: z.string().nullable(),
  /** True when a file in this list changed after the first page. The scroll can miss it. */
  listChanged: z.boolean().optional(),
});
export type ProjectLibraryFilesPage = z.infer<typeof ProjectLibraryFilesPageSchema>;

export const ProjectFilePickerEntrySchema = z.object({
  fileId: z.string(),
  name: z.string(),
  kind: z.enum(["published", "draft"]),
  folderId: z.string().nullable(),
  folderPath: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int().positive(),
});
export type ProjectFilePickerEntry = z.infer<typeof ProjectFilePickerEntrySchema>;
export const ProjectFilePickerQuerySchema = z.object({
  q: SearchSchema,
  kind: z.enum(["published", "any"]).default("any"),
  limit: PageLimitSchema,
  cursor: PageCursorSchema,
}).strict();
export type ProjectFilePickerQuery = z.infer<typeof ProjectFilePickerQuerySchema>;
export const ProjectFilePickerPageSchema = z.object({
  items: z.array(ProjectFilePickerEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ProjectFilePickerPage = z.infer<typeof ProjectFilePickerPageSchema>;
export const ProjectFilePickerSelectionQuerySchema = z.object({
  ids: z.union([z.string().uuid(), z.array(z.string().uuid())])
    .transform((value) => [...new Set(Array.isArray(value) ? value : [value])])
    .pipe(z.array(z.string().uuid()).min(1).max(20)),
}).strict();
export const ProjectFilePickerSelectionSchema = z.object({
  items: z.array(ProjectFilePickerEntrySchema),
});

export const ProjectFolderListQuerySchema = z.object({
  parentId: z.string().uuid().optional(),
  q: SearchSchema,
  limit: PageLimitSchema,
  cursor: PageCursorSchema,
}).strict().refine((value) => !(value.parentId && value.q),
  "Use a parent folder or a search term.");
export type ProjectFolderListQuery = z.infer<typeof ProjectFolderListQuerySchema>;
export const ProjectFolderEntrySchema = ProjectFolderSchema.extend({ path: z.string() });
export type ProjectFolderEntry = z.infer<typeof ProjectFolderEntrySchema>;
export const ProjectFolderPageSchema = z.object({
  items: z.array(ProjectFolderEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ProjectFolderPage = z.infer<typeof ProjectFolderPageSchema>;
export const ProjectFolderDetailSchema = z.object({
  folder: ProjectFolderSchema,
  ancestors: z.array(z.object({ folderId: z.string(), name: z.string() })).max(8),
  ancestorsTruncated: z.boolean(),
  nearestLiveFolderId: z.string().nullable(),
});
export type ProjectFolderDetail = z.infer<typeof ProjectFolderDetailSchema>;
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
