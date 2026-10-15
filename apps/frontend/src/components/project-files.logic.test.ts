import { expect, test } from "vitest";
import type { ProjectFolderDetail, ProjectLibraryFile } from "@cogniplane/shared-types";
import { folderDetailPath, hasTargetConflict } from "./project-files.logic";

const detail: ProjectFolderDetail = {
  folder: { folderId: "b", parentId: "a", name: "Notes", deletedAt: null },
  ancestors: [{ folderId: "a", name: "Research" }],
  ancestorsTruncated: false,
  nearestLiveFolderId: "b",
};
test("formats folder paths from detail, including truncated and removed folders", () => {
  expect(folderDetailPath(detail)).toBe("Files / Research / Notes");
  expect(folderDetailPath({ ...detail, ancestorsTruncated: true })).toBe(
    "Files / … / Research / Notes",
  );
  expect(
    folderDetailPath({
      ...detail,
      folder: { ...detail.folder, deletedAt: "2026-09-14T00:00:00Z" },
    }),
  ).toBe("Missing folder");
});
test("reports a conflict only when an available target advanced past the draft base", () => {
  const draft = {
    fileId: "d",
    kind: "draft",
    trashedAt: null,
    baseVersionId: "v1",
    target: { fileId: "f", name: "Brief.txt", currentVersionId: "v2", available: true },
  } as ProjectLibraryFile;
  expect(hasTargetConflict(draft)).toBe(true);
  expect(hasTargetConflict({ ...draft, target: { ...draft.target!, currentVersionId: "v1" } })).toBe(false);
  expect(hasTargetConflict({ ...draft, target: { ...draft.target!, available: false } })).toBe(false);
  expect(hasTargetConflict({ ...draft, target: null })).toBe(false);
  expect(hasTargetConflict({ ...draft, trashedAt: "2026-09-14T00:00:00Z" })).toBe(false);
  expect(hasTargetConflict({ ...draft, kind: "published" })).toBe(false);
});
