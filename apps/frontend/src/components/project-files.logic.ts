import type { ProjectFile, ProjectFolder } from "@cogniplane/shared-types";

export function projectFolderPath(
  folders: ProjectFolder[],
  folderId: string | null,
): string {
  if (!folderId) return "Files";
  const names: string[] = [],
    seen = new Set<string>();
  while (folderId) {
    const current = folders.find((folder) => folder.folderId === folderId);
    if (!current || current.deletedAt || seen.has(folderId))
      return "Missing folder";
    seen.add(folderId);
    names.unshift(current.name);
    folderId = current.parentId;
  }
  return `Files / ${names.join(" / ")}`;
}
export function selectProjectFiles(
  files: ProjectFile[],
  options: {
    section: "published" | "draft" | "trash";
    folderId: string | null;
    query: string;
    sort: "name" | "updated";
  },
) {
  const query = options.query.trim().toLowerCase();
  return files
    .filter((file) => {
      if (!file.name.toLowerCase().includes(query)) return false;
      if (options.section === "trash") return Boolean(file.trashedAt);
      if (file.trashedAt || file.kind !== options.section) return false;
      return (
        options.section === "draft" ||
        Boolean(query) ||
        file.folderId === options.folderId
      );
    })
    .sort((a, b) =>
      options.sort === "name"
        ? a.name.localeCompare(b.name) || a.fileId.localeCompare(b.fileId)
        : Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          a.fileId.localeCompare(b.fileId),
    );
}
