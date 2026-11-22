import {
  ArtifactPreviewTextResponseSchema,
  ProjectFileSchema,
  ProjectFileHistorySchema,
  ProjectFilePickerPageSchema,
  ProjectFilePickerSelectionSchema,
  ProjectFolderDetailSchema,
  ProjectFolderPageSchema,
  ProjectLibraryFilesPageSchema,
  type ProjectFileCreate,
} from "@cogniplane/shared-types";
import { fetchWithAuthRetry, buildErrorMessage, requestJson, requestEmpty } from "./api-client";
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
  return await requestJson(withQuery(`${path(projectId)}/files`, searchParams(input)), ProjectLibraryFilesPageSchema, { signal });
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
  return await requestJson(withQuery(`${path(projectId)}/folders`, searchParams(input)), ProjectFolderPageSchema, { signal });
}
export async function getProjectFolder(
  projectId: string,
  folderId: string,
  signal?: AbortSignal,
) {
  return await requestJson(`${path(projectId)}/folders/${encodeURIComponent(folderId)}`, ProjectFolderDetailSchema, { signal });
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
  return await requestJson(withQuery(`${path(projectId)}/picker`, searchParams(input)), ProjectFilePickerPageSchema, { signal });
}
/** Returns the live published files and drafts among `fileIds`. Missing IDs are deleted or inaccessible. */
export async function getProjectFilePickerSelection(
  projectId: string,
  fileIds: string[],
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  for (const fileId of fileIds) params.append("ids", fileId);
  return await requestJson(withQuery(`${path(projectId)}/picker/selection`, params), ProjectFilePickerSelectionSchema, { signal });
}
export async function saveProjectFile(
  projectId: string,
  input: ProjectFileCreate,
) {
  return await requestJson(`${path(projectId)}/files`, ProjectFileSchema, {
      method: "POST",
      body: JSON.stringify(input),
    });
}
export async function promoteProjectDraft(projectId: string, fileId: string) {
  return await requestJson(`${filePath(projectId, fileId)}/promote`, ProjectFileSchema, { method: "POST" });
}
export async function changeProjectFileLocation(
  projectId: string,
  fileId: string,
  input: { name: string; folderId: string | null },
  action: "location" | "restore" | "save-as-new" = "location",
) {
  await requestEmpty(`${filePath(projectId, fileId)}/${action}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
export async function trashProjectFile(projectId: string, fileId: string) {
  await requestEmpty(filePath(projectId, fileId), { method: "DELETE" });
}
export async function createProjectFolder(
  projectId: string,
  name: string,
  parentId: string | null,
) {
  await requestEmpty(`${path(projectId)}/folders`, {
    method: "POST",
    body: JSON.stringify({ name, parentId }),
  });
}
export async function renameProjectFolder(
  projectId: string,
  folderId: string,
  name: string,
) {
  await requestEmpty(`${path(projectId)}/folders/${encodeURIComponent(folderId)}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}
export async function removeProjectFolder(projectId: string, folderId: string) {
  await requestEmpty(`${path(projectId)}/folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
  });
}
export async function getProjectFileHistory(projectId: string, fileId: string) {
  return await requestJson(`${filePath(projectId, fileId)}/versions`, ProjectFileHistorySchema);
}
export async function restoreProjectFileVersion(
  projectId: string,
  fileId: string,
  versionId: string,
  expectedVersionId: string,
) {
  await requestEmpty(`${versionPath(projectId, fileId, versionId)}/restore`, {
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
  const result = await requestJson(
    `${versionPath(projectId, fileId, versionId)}/preview-text`,
    ArtifactPreviewTextResponseSchema,
  );
  return result.text;
}
