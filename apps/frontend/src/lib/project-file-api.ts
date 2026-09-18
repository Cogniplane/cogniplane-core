import {
  ProjectLibrarySchema,
  ProjectFileSchema,
  ProjectFileHistorySchema,
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
export async function getProjectLibrary(projectId: string) {
  return parseResponse(
    ProjectLibrarySchema,
    await request(path(projectId)),
    "GET project library",
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
