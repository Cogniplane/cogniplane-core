import type { ProjectFolderDetail, ProjectLibraryFile } from "@cogniplane/shared-types";

/** Formats a folder detail like the server's `folderPath`: "Files / Research / Notes". */
export function folderDetailPath(detail: ProjectFolderDetail): string {
  if (detail.folder.deletedAt) return "Missing folder";
  return [
    "Files",
    ...(detail.ancestorsTruncated ? ["…"] : []),
    ...detail.ancestors.map((ancestor) => ancestor.name),
    detail.folder.name,
  ].join(" / ");
}

/** True when a live draft updates a published file that changed after the draft's base version. */
export function hasTargetConflict(file: ProjectLibraryFile): boolean {
  return (
    file.kind === "draft" &&
    !file.trashedAt &&
    Boolean(file.target?.available) &&
    file.target?.currentVersionId !== file.baseVersionId
  );
}
