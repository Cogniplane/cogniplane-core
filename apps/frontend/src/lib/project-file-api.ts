import {
  ProjectFileSchema,
  ProjectFileHistorySchema,
  ProjectFilePickerPageSchema,
  ProjectFilePickerSelectionSchema,
  ProjectFolderDetailSchema,
  ProjectFolderPageSchema,
  ProjectLibraryFilesPageSchema,
  type ProjectFileCreate,
} from "@cogniplane/shared-types";
import { request, fetchWithAuthRetry, buildErrorMessage } from "./api-client";
import { parseResponse } from "./validate-response";
const path = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/library`;
const filePath = (projectId: string, fileId: string) =>
  `${path(projectId)}/files/${encodeURIComponent(fileId)}`;
const versionPath = (projectId: string, fileId: string, versionId: string) =>
  `${filePath(projectId, fileId)}/versions/${encodeURIComponent(versionId)}`;
const withQuery = (base: string, params: URLSearchParams) => {
  const query = params.toString();
  return query ? `${base}?${query}` : base;
};
const searchParams = (values: Record<string, string | number | null | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params;
};
export type ProjectLibraryFilesParams = {
  section: "published" | "draft" | "trash";
  folderId?: string | null;
  q?: string;
  sort: "updated" | "name";
  limit?: number;
  cursor?: string;
};
export async function listProjectLibraryFiles(
  projectId: string,
  input: ProjectLibraryFilesParams,
  signal?: AbortSignal,
) {
  return parseResponse(
    ProjectLibraryFilesPageSchema,
    await request(withQuery(`${path(projectId)}/files`, searchParams(input)), { signal }),
    "GET project library files",
  );
}
export type ProjectFolderListParams = {
  parentId?: string | null;
  q?: string;
  limit?: number;
  cursor?: string;
};
export async function listProjectFolders(
  projectId: string,
  input: ProjectFolderListParams,
  signal?: AbortSignal,
) {
  return parseResponse(
    ProjectFolderPageSchema,
    await request(withQuery(`${path(projectId)}/folders`, searchParams(input)), { signal }),
    "GET project folders",
  );
}
export async function getProjectFolder(
  projectId: string,
  folderId: string,
  signal?: AbortSignal,
) {
  return parseResponse(
    ProjectFolderDetailSchema,
    await request(`${path(projectId)}/folders/${encodeURIComponent(folderId)}`, { signal }),
    "GET project folder",
  );
}
export type ProjectFilePickerParams = {
  q?: string;
  kind?: "published" | "any";
  limit?: number;
  cursor?: string;
};
export async function listProjectFilePicker(
  projectId: string,
  input: ProjectFilePickerParams,
  signal?: AbortSignal,
) {
  return parseResponse(
    ProjectFilePickerPageSchema,
    await request(withQuery(`${path(projectId)}/picker`, searchParams(input)), { signal }),
    "GET project file picker",
  );
}
/** Returns the live published files and drafts among `fileIds`. Missing IDs are deleted or inaccessible. */
export async function getProjectFilePickerSelection(
  projectId: string,
  fileIds: string[],
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  for (const fileId of fileIds) params.append("ids", fileId);
  return parseResponse(
    ProjectFilePickerSelectionSchema,
    await request(withQuery(`${path(projectId)}/picker/selection`, params), { signal }),
    "GET project file selection",
  );
}
export async function saveProjectFile(
  projectId: string,
  input: ProjectFileCreate,
) {
  return parseResponse(
    ProjectFileSchema,
    await request(`${path(projectId)}/files`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
    "POST project file",
  );
}
export async function promoteProjectDraft(projectId: string, fileId: string) {
  return parseResponse(
    ProjectFileSchema,
    await request(`${filePath(projectId, fileId)}/promote`, { method: "POST" }),
    "POST draft promotion",
  );
}
export async function changeProjectFileLocation(
  projectId: string,
  fileId: string,
  input: { name: string; folderId: string | null },
  action: "location" | "restore" | "save-as-new" = "location",
) {
  await request(`${filePath(projectId, fileId)}/${action}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
export async function trashProjectFile(projectId: string, fileId: string) {
  await request(filePath(projectId, fileId), { method: "DELETE" });
}
export async function createProjectFolder(
  projectId: string,
  name: string,
  parentId: string | null,
) {
  await request(`${path(projectId)}/folders`, {
    method: "POST",
    body: JSON.stringify({ name, parentId }),
  });
}
export async function renameProjectFolder(
  projectId: string,
  folderId: string,
  name: string,
) {
  await request(`${path(projectId)}/folders/${encodeURIComponent(folderId)}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}
export async function removeProjectFolder(projectId: string, folderId: string) {
  await request(`${path(projectId)}/folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
  });
}
export async function getProjectFileHistory(projectId: string, fileId: string) {
  return parseResponse(
    ProjectFileHistorySchema,
    await request(`${filePath(projectId, fileId)}/versions`),
    "GET file history",
  );
}
export async function restoreProjectFileVersion(
  projectId: string,
  fileId: string,
  versionId: string,
  expectedVersionId: string,
) {
  await request(`${versionPath(projectId, fileId, versionId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ expectedVersionId }),
  });
}
export async function getProjectVersionBlob(
  projectId: string,
  fileId: string,
  versionId: string,
) {
  const response = await fetchWithAuthRetry(
    `${versionPath(projectId, fileId, versionId)}/content`,
  );
  if (!response.ok) throw new Error(await buildErrorMessage(response));
  return response.blob();
}
export async function getProjectVersionPdfText(
  projectId: string,
  fileId: string,
  versionId: string,
) {
  const result = await request<{ text: string }>(
    `${versionPath(projectId, fileId, versionId)}/preview-text`,
  );
  return result.text;
}
