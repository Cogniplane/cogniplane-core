import { expect, test } from "vitest";
import type { ProjectFile, ProjectFolder } from "@cogniplane/shared-types";
import { projectFolderPath, selectProjectFiles } from "./project-files.logic";
const base = {
  fileId: "a",
  name: "Alpha",
  kind: "published",
  folderId: null,
  createdByType: "user",
  trashedAt: null,
  updatedAt: "2026-09-14T01:00:00Z",
} as ProjectFile;
test("default file browsing excludes drafts and Trash; search spans folders and matches names only", () => {
  const files = [
    base,
    { ...base, fileId: "draft", kind: "draft" as const },
    { ...base, fileId: "trash", trashedAt: base.updatedAt },
    { ...base, fileId: "nested", folderId: "f", name: "Beta" },
  ];
  const options = {
    section: "published" as const,
    folderId: null,
    query: "",
    sort: "name" as const,
  };
  expect(selectProjectFiles(files, options).map((file) => file.fileId)).toEqual(
    ["a"],
  );
  expect(
    selectProjectFiles(files, { ...options, query: " BET " }).map(
      (file) => file.fileId,
    ),
  ).toEqual(["nested"]);
  expect(
    selectProjectFiles(files, {
      ...options,
      section: "draft",
      folderId: "other",
    }).map((file) => file.fileId),
  ).toEqual(["draft"]);
  expect(
    selectProjectFiles(files, { ...options, section: "trash" }).map(
      (file) => file.fileId,
    ),
  ).toEqual(["trash"]);
});
test("sorts names and update timestamps without mutating the library", () => {
  const files = [
    { ...base, name: "Zulu" },
    { ...base, fileId: "b", name: "Alpha", updatedAt: "2026-09-13T00:00:00Z" },
  ];
  const options = {
    section: "published" as const,
    folderId: null,
    query: "",
    sort: "name" as const,
  };
  expect(selectProjectFiles(files, options).map((file) => file.name)).toEqual([
    "Alpha",
    "Zulu",
  ]);
  expect(
    selectProjectFiles(files, { ...options, sort: "updated" }).map(
      (file) => file.name,
    ),
  ).toEqual(["Zulu", "Alpha"]);
  expect(files[0].name).toBe("Zulu");
});
test("resolves nested folder names and identifies missing or removed destinations", () => {
  const folders: ProjectFolder[] = [
    { folderId: "a", parentId: null, name: "Research", deletedAt: null },
    { folderId: "b", parentId: "a", name: "Notes", deletedAt: null },
  ];
  expect(projectFolderPath(folders, "b")).toBe("Files / Research / Notes");
  expect(projectFolderPath(folders, "missing")).toBe("Missing folder");
  expect(
    projectFolderPath(
      [{ ...folders[0], deletedAt: "2026-09-14T00:00:00Z" }],
      "a",
    ),
  ).toBe("Missing folder");
});
