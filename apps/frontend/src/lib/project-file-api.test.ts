import { beforeEach, expect, it, vi } from "vitest";
import { request } from "./api-client";
import {
  getProjectFilePickerSelection,
  getProjectFolder,
  listProjectFilePicker,
  listProjectFolders,
  listProjectLibraryFiles,
} from "./project-file-api";
vi.mock("./api-client", () => ({
  request: vi.fn(),
  fetchWithAuthRetry: vi.fn(),
  buildErrorMessage: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

it("encodes page filters and omits empty ones", async () => {
  vi.mocked(request).mockResolvedValue({ items: [], nextCursor: null });
  await listProjectLibraryFiles("p/1", { section: "published", folderId: null, q: "", sort: "name" });
  expect(request).toHaveBeenLastCalledWith(
    "/projects/p%2F1/library/files?section=published&sort=name",
    { signal: undefined },
  );
  await listProjectLibraryFiles("p", { section: "trash", q: "a&b", sort: "updated", cursor: "c+/=" });
  expect(request).toHaveBeenLastCalledWith(
    "/projects/p/library/files?section=trash&q=a%26b&sort=updated&cursor=c%2B%2F%3D",
    { signal: undefined },
  );
  await listProjectFolders("p", { parentId: "f1" });
  expect(request).toHaveBeenLastCalledWith("/projects/p/library/folders?parentId=f1", { signal: undefined });
  await listProjectFilePicker("p", { kind: "published" });
  expect(request).toHaveBeenLastCalledWith("/projects/p/library/picker?kind=published", { signal: undefined });
});

it("repeats selection IDs and parses folder detail", async () => {
  vi.mocked(request).mockResolvedValueOnce({ items: [] });
  await getProjectFilePickerSelection("p", ["a", "b"]);
  expect(request).toHaveBeenLastCalledWith("/projects/p/library/picker/selection?ids=a&ids=b", { signal: undefined });
  vi.mocked(request).mockResolvedValueOnce({
    folder: { folderId: "f", parentId: null, name: "Research", deletedAt: null },
    ancestors: [],
    ancestorsTruncated: false,
    nearestLiveFolderId: "f",
  });
  await expect(getProjectFolder("p", "f")).resolves.toMatchObject({ folder: { name: "Research" } });
});

it("rejects a page without a cursor field", async () => {
  vi.mocked(request).mockResolvedValue({ items: [] });
  await expect(listProjectFolders("p", {})).rejects.toThrow();
});
