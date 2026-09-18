"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type {
  Artifact,
  Project,
  ProjectFile,
  ProjectFileVersion,
} from "@cogniplane/shared-types";
import { isTextReadableArtifact, SESSION_TRASH_RETENTION_DAYS } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactPreviewModal } from "./artifact-preview-modal";
import {
  canPreviewArtifact,
  isImageArtifact,
  isPdfArtifact,
} from "@/lib/artifact-preview";
import { formatFileSize } from "./artifact-panel.logic";
import { uploadArtifact } from "@/lib/artifact-api";
import * as api from "@/lib/project-file-api";
import { createProjectSession } from "@/lib/project-api";
import { projectFolderPath, selectProjectFiles } from "./project-files.logic";
import { queryKeys } from "@/lib/query-keys";
import { fetchModels } from "../lib/api-client";

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-outline-variant bg-surface-container-lowest px-2 text-sm disabled:opacity-50";

function VersionPreview({
  projectId,
  file,
  version,
  onClose,
}: {
  projectId: string;
  file: ProjectFile;
  version: ProjectFileVersion;
  onClose: () => void;
}) {
  const [result, setResult] = useState<{
    content: string | null;
    imageUrl: string | null;
    error: string | null;
  }>({ content: null, imageUrl: null, error: null });
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const load = async () => {
      if (isPdfArtifact(version.mimeType)) {
        return api.getProjectVersionPdfText(
          projectId,
          file.fileId,
          version.versionId,
        );
      }
      const blob = await api.getProjectVersionBlob(
        projectId,
        file.fileId,
        version.versionId,
      );
      return isImageArtifact(version.mimeType) ? blob : blob.text();
    };
    void load()
      .then((content) => {
        if (!active) return;
        if (typeof content === "string")
          setResult({ content, imageUrl: null, error: null });
        else {
          objectUrl = URL.createObjectURL(content);
          setResult({ content: null, imageUrl: objectUrl, error: null });
        }
      })
      .catch((error: unknown) => {
        if (active)
          setResult({
            content: null,
            imageUrl: null,
            error: error instanceof Error ? error.message : "Preview failed.",
          });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, file.fileId, version.versionId, version.mimeType]);
  return (
    <ArtifactPreviewModal
      artifactName={`${file.name} · Version ${version.versionNumber}`}
      mimeType={version.mimeType}
      {...result}
      onClose={onClose}
    />
  );
}

export function ProjectFiles({
  project,
  sources,
  canEdit = true,
}: {
  project: Project;
  sources: Artifact[];
  canEdit?: boolean;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const capabilitiesQuery = useQuery({
    queryKey: queryKeys.models.list(),
    queryFn: fetchModels
  });
  const [section, setSection] = useState<"published" | "draft" | "trash">(
    "published",
  );
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "updated">("updated");
  const [folderName, setFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [kind, setKind] = useState<"published" | "draft">("published");
  const [target, setTarget] = useState<ProjectFile | null>(null);
  const [editing, setEditing] = useState<{
    file: ProjectFile;
    name: string;
    folderId: string;
    asNew: boolean;
  } | null>(null);
  const [removing, setRemoving] = useState<ProjectFile | null>(null);
  const [historyFile, setHistoryFile] = useState<ProjectFile | null>(null);
  const [preview, setPreview] = useState<{
    file: ProjectFile;
    version: ProjectFileVersion;
  } | null>(null);
  const library = useQuery({
    queryKey: queryKeys.projects.library(project.projectId),
    queryFn: () => api.getProjectLibrary(project.projectId),
  });
  const history = useQuery({
    queryKey: ["projects", project.projectId, "history", historyFile?.fileId],
    queryFn: () =>
      api.getProjectFileHistory(project.projectId, historyFile!.fileId),
    enabled: Boolean(historyFile),
  });
  const files = library.data?.files ?? [],
    folders = library.data?.folders ?? [];
  const liveFolders = folders.filter((folder) => !folder.deletedAt);
  const published = files.filter(
    (file) => file.kind === "published" && !file.trashedAt,
  );
  const currentFolder = liveFolders.find(
    (folder) => folder.folderId === folderId,
  );
  const readySources = sources.filter(
    (file) =>
      file.status === "ready" &&
      file.artifactType !== "derived" &&
      (!file.detail.pii?.status ||
        ["scanned", "transformed"].includes(file.detail.pii.status)),
  );
  const source = readySources.find((file) => file.artifactId === sourceId);
  const mutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const download = useMutation({
    mutationFn: async ({
      file,
      version,
    }: {
      file: ProjectFile;
      version: ProjectFileVersion;
    }) => {
      const blob = await api.getProjectVersionBlob(
        project.projectId,
        file.fileId,
        version.versionId,
      );
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  const disabled = !canEdit || Boolean(project.archivedAt) || mutation.isPending;
  const folderOptions = (
    <>
      <option value="">Files</option>
      {liveFolders.map((folder) => (
        <option key={folder.folderId} value={folder.folderId}>
          {projectFolderPath(folders, folder.folderId)}
        </option>
      ))}
    </>
  );
  const visible = selectProjectFiles(files, { section, folderId, query, sort });
  const canResolveConflict = (file: ProjectFile) => {
    const enabledToolIds = capabilitiesQuery.data?.enabledToolIds ?? [];
    if (!enabledToolIds.includes("project_get_conflict_context") || !enabledToolIds.includes("project_reconcile_conflict")) return false;
    if (project.agentFileMode !== "read-write" || file.kind !== "draft" || !file.targetFileId || file.trashedAt) return false;
    const target = files.find((candidate) => candidate.fileId === file.targetFileId);
    if (!target || target.kind !== "published" || target.trashedAt || target.version.versionId === file.baseVersionId) return false;
    return isTextReadableArtifact(file.version.mimeType);
  };
  const fileActions = (file: ProjectFile, version = file.version) => (
    <>
      {canPreviewArtifact({ mimeType: version.mimeType, status: "ready" }) ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setPreview({ file, version })}
        >
          Preview
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={download.isPending}
        onClick={() => download.mutate({ file, version })}
      >
        Download
      </Button>
    </>
  );
  const edit = (file: ProjectFile) => {
    mutation.reset();
    setEditing({
      file,
      name: file.name,
      folderId: file.folderId ?? "",
      asNew: false,
    });
  };
  return (
    <section aria-label="Project files" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Project files</h3>
        <nav aria-label="Project file sections" className="flex gap-1">
          <Button
            size="sm"
            variant={section === "published" ? "default" : "ghost"}
            aria-pressed={section === "published"}
            onClick={() => setSection("published")}
          >
            Files
          </Button>
          <Button
            size="sm"
            variant={section === "draft" ? "default" : "ghost"}
            aria-pressed={section === "draft"}
            onClick={() => setSection("draft")}
          >
            Drafts
          </Button>
          <Button
            size="sm"
            variant={section === "trash" ? "default" : "ghost"}
            aria-pressed={section === "trash"}
            onClick={() => setSection("trash")}
          >
            Trash
          </Button>
        </nav>
      </div>
      {project.archivedAt ? (
        <p className="text-sm text-on-surface-variant">
          Restore this project to change its files.
        </p>
      ) : null}
      {!canEdit ? (
        <p className="text-sm text-on-surface-variant">You have read-only access to this project&apos;s files.</p>
      ) : null}
      {library.isPending ? <Skeleton className="h-32" /> : null}
      {library.isError ? (
        <div role="alert">
          <p>Could not load project files.</p>
          <Button variant="outline" onClick={() => void library.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {mutation.isError || download.isError ? (
        <p role="alert" className="text-sm text-danger">
          {mutation.error?.message ?? download.error?.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Input
          aria-label="Search project file names"
          placeholder="Search file names"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-48 flex-1"
        />
        <select
          aria-label="Sort project files"
          className={SELECT + " sm:w-44"}
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
        >
          <option value="updated">Last updated</option>
          <option value="name">Name</option>
        </select>
      </div>
      {section === "published" ? (
        <div className="flex flex-col gap-3">
          <nav
            aria-label="Project folders"
            className="flex flex-wrap items-center gap-2"
          >
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setFolderId(null);
                setRenamingFolder(false);
              }}
            >
              Files
            </Button>
            {folderId ? (
              <>
                <span className="text-sm">
                  /{" "}
                  {projectFolderPath(folders, folderId).replace(
                    /^Files \/ /,
                    "",
                  )}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setFolderId(currentFolder?.parentId ?? null);
                    setRenamingFolder(false);
                  }}
                >
                  Up one folder
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled || !currentFolder}
                  onClick={() => {
                    setFolderName(currentFolder!.name);
                    setRenamingFolder(true);
                  }}
                >
                  Rename folder
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled || !currentFolder}
                  onClick={() =>
                    mutation.mutate(async () => {
                      await api.removeProjectFolder(
                        project.projectId,
                        folderId,
                      );
                      setFolderId(currentFolder?.parentId ?? null);
                    })
                  }
                >
                  Remove empty folder
                </Button>
              </>
            ) : null}
          </nav>
          {!query ? (
            <div className="flex flex-wrap gap-2">
              {liveFolders
                .filter((folder) => folder.parentId === folderId)
                .map((folder) => (
                  <Button
                    key={folder.folderId}
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFolderId(folder.folderId);
                      setRenamingFolder(false);
                    }}
                  >
                    {folder.name} /
                  </Button>
                ))}
            </div>
          ) : null}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate(async () => {
                if (renamingFolder && folderId)
                  await api.renameProjectFolder(
                    project.projectId,
                    folderId,
                    folderName.trim(),
                  );
                else
                  await api.createProjectFolder(
                    project.projectId,
                    folderName.trim(),
                    folderId,
                  );
                setFolderName("");
                setRenamingFolder(false);
              });
            }}
          >
            <Input
              aria-label="Folder name"
              maxLength={255}
              placeholder={renamingFolder ? "New folder name" : "New folder"}
              value={folderName}
              disabled={disabled}
              onChange={(event) => setFolderName(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !folderName.trim()}
            >
              {renamingFolder ? "Save folder name" : "Create folder"}
            </Button>
            {renamingFolder ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setRenamingFolder(false);
                  setFolderName("");
                }}
              >
                Cancel
              </Button>
            ) : null}
          </form>
        </div>
      ) : (
        <p className="text-sm text-on-surface-variant">
          {section === "draft"
            ? "Drafts from every folder appear here. Promote a draft to publish it."
            : "Files and drafts can be recovered for 30 days after removal."}
        </p>
      )}
      {library.data && visible.length === 0 ? (
        <p className="text-sm text-on-surface-variant">
          {query
            ? "No file names match your search."
            : section === "draft"
              ? "No drafts to review."
              : section === "trash"
                ? "Trash is empty."
                : "No published files in this folder."}
        </p>
      ) : null}
      <ul className="divide-y divide-outline-variant">
        {visible.map((file) => (
          <li
            key={file.fileId}
            className="flex flex-wrap items-center gap-3 py-3"
          >
            <div className="min-w-0 flex-1 basis-48">
              <p className="break-words text-sm font-medium">{file.name}</p>
              <p className="text-xs text-on-surface-variant">
                {projectFolderPath(folders, file.folderId)} · Version{" "}
                {file.version.versionNumber} ·{" "}
                {formatFileSize(file.version.fileSizeBytes)}
              </p>
              <p className="text-xs text-on-surface-variant">
                Created by {file.createdByType === "agent" ? "an agent" : "a person"}
              </p>
              {file.targetFileId ? (
                <p className="text-xs text-on-surface-variant">
                  Updates{" "}
                  {files.find((target) => target.fileId === file.targetFileId)
                    ?.name ?? "an unavailable file"}
                </p>
              ) : null}
              {file.trashedAt ? (
                <p className="text-xs text-on-surface-variant">
                  Removed {new Date(file.trashedAt).toLocaleDateString()}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1">
              {file.trashedAt ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => edit(file)}
                >
                  Restore file
                </Button>
              ) : (
                <>
                  {fileActions(file)}
                  {file.kind === "draft" ? (
                    <>
                      <Button
                        size="xs"
                        disabled={disabled}
                        onClick={() =>
                          mutation.mutate(() =>
                            api.promoteProjectDraft(
                              project.projectId,
                              file.fileId,
                            ),
                          )
                        }
                      >
                        Promote draft
                      </Button>
                      {canResolveConflict(file) ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={disabled}
                          onClick={() =>
                            mutation.mutate(async () => {
                              const session = await createProjectSession(
                                project.projectId,
                                `Resolve ${file.name}`,
                              );
                              router.push(
                                `/?session=${encodeURIComponent(session.sessionId)}&resolveDraft=${encodeURIComponent(file.fileId)}`,
                              );
                            })
                          }
                        >
                          Resolve with agent
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setHistoryFile(file)}
                  >
                    History
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => edit(file)}
                  >
                    Rename or move
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setRemoving(file)}
                  >
                    Move to Trash
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {removing ? (
        <div
          role="group"
          aria-label="Confirm file removal"
          className="flex flex-col gap-2"
        >
          <p className="text-sm">
            Move {removing.name} to Trash? It can be recovered for {SESSION_TRASH_RETENTION_DAYS} days.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() =>
                mutation.mutate(async () => {
                  await api.trashProjectFile(
                    project.projectId,
                    removing.fileId,
                  );
                  setRemoving(null);
                })
              }
            >
              Confirm removal
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {editing ? (
        <form
          aria-label="File location"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(async () => {
              await api.changeProjectFileLocation(
                project.projectId,
                editing.file.fileId,
                {
                  name: editing.name.trim(),
                  folderId: editing.folderId || null,
                },
                editing.file.trashedAt
                  ? "restore"
                  : editing.asNew
                    ? "save-as-new"
                    : "location",
              );
              setEditing(null);
            });
          }}
        >
          <Label htmlFor="project-file-name">File name</Label>
          <Input
            id="project-file-name"
            value={editing.name}
            maxLength={255}
            onChange={(event) =>
              setEditing({ ...editing, name: event.target.value })
            }
          />
          <Label htmlFor="project-file-destination">Destination folder</Label>
          <select
            id="project-file-destination"
            className={SELECT}
            value={editing.folderId}
            onChange={(event) =>
              setEditing({ ...editing, folderId: event.target.value })
            }
          >
            {folderOptions}
            {editing.folderId &&
            !liveFolders.some(
              (folder) => folder.folderId === editing.folderId,
            ) ? (
              <option value={editing.folderId} disabled>
                Missing folder. Choose a destination.
              </option>
            ) : null}
          </select>
          {editing.file.kind === "draft" &&
          editing.file.targetFileId &&
          !editing.file.trashedAt ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editing.asNew}
                onChange={(event) =>
                  setEditing({ ...editing, asNew: event.target.checked })
                }
              />
              Save as a separate draft instead of updating the original file
            </label>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                disabled ||
                !editing.name.trim() ||
                Boolean(
                  editing.folderId &&
                  !liveFolders.some(
                    (folder) => folder.folderId === editing.folderId,
                  ),
                )
              }
            >
              {editing.file.trashedAt ? "Confirm restore" : "Save location"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {historyFile ? (
        <section
          aria-label="File version history"
          className="flex flex-col gap-2"
        >
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">
              History of {historyFile.name}
            </h4>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setHistoryFile(null)}
            >
              Close history
            </Button>
          </div>
          {history.isPending ? <p>Loading versions...</p> : null}
          {history.isError ? (
            <div role="alert">
              <p>Could not load versions.</p>
              <Button variant="ghost" onClick={() => void history.refetch()}>
                Retry history
              </Button>
            </div>
          ) : null}
          {history.data?.map((version) => (
            <div
              key={version.versionId}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-sm">
                Version {version.versionNumber} ·{" "}
                {new Date(version.createdAt).toLocaleString()}
              </span>
              {fileActions(historyFile, version)}
              {historyFile.kind === "published" &&
              version.versionId !==
                files.find((file) => file.fileId === historyFile.fileId)
                  ?.version.versionId ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    mutation.mutate(() =>
                      api.restoreProjectFileVersion(
                        project.projectId,
                        historyFile.fileId,
                        version.versionId,
                        files.find((file) => file.fileId === historyFile.fileId)
                          ?.version.versionId ?? historyFile.version.versionId,
                      ),
                    )
                  }
                >
                  Restore as new version
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      <details className="border-t border-outline-variant pt-4">
        <summary className="cursor-pointer text-sm font-medium">
          Add a file or draft
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <Label htmlFor="project-upload">Upload a file</Label>
          <input
            id="project-upload"
            type="file"
            disabled={disabled}
            onChange={(event) => {
              const upload = event.target.files?.[0];
              event.target.value = "";
              if (upload)
                mutation.mutate(async () => {
                  const artifact = await uploadArtifact({
                    sessionId: project.referenceSessionId,
                    file: upload,
                  });
                  setSourceId(artifact.artifactId);
                  setName(artifact.artifactName);
                });
            }}
          />
          <p className="text-xs text-on-surface-variant">
            Choose a ready upload or session file below. Files still being
            checked become available when processing finishes.
          </p>
          {sourceId && !source ? (
            <p role="status" className="text-sm">
              The selected file is not ready. Wait for its checks or choose
              another source.
            </p>
          ) : null}
          <form
            aria-label="Save project file"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!source) return;
              mutation.mutate(async () => {
                await api.saveProjectFile(project.projectId, {
                  artifactId: source.artifactId,
                  name: name.trim(),
                  folderId: destination || null,
                  kind: target ? "draft" : kind,
                  targetFileId: target?.fileId ?? null,
                  baseVersionId: target?.version.versionId ?? null,
                });
                setName("");
                setSourceId("");
                setTarget(null);
              });
            }}
          >
            <Label htmlFor="project-file-source">Source file</Label>
            <select
              id="project-file-source"
              className={SELECT}
              value={source?.artifactId ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const artifact = readySources.find(
                  (file) => file.artifactId === event.target.value,
                );
                setSourceId(event.target.value);
                setName(artifact?.artifactName ?? "");
              }}
            >
              <option value="">Choose a ready file...</option>
              {readySources.map((file) => (
                <option key={file.artifactId} value={file.artifactId}>
                  {file.artifactName}
                </option>
              ))}
            </select>
            <Label htmlFor="project-save-name">File name</Label>
            <Input
              id="project-save-name"
              value={name}
              maxLength={255}
              disabled={disabled}
              onChange={(event) => setName(event.target.value)}
            />
            <Label htmlFor="project-save-folder">Destination folder</Label>
            <select
              id="project-save-folder"
              className={SELECT}
              value={destination}
              disabled={disabled}
              onChange={(event) => setDestination(event.target.value)}
            >
              {folderOptions}
            </select>
            <Label htmlFor="project-save-target">New file or update</Label>
            <select
              id="project-save-target"
              className={SELECT}
              value={target?.fileId ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const next =
                  published.find(
                    (file) => file.fileId === event.target.value,
                  ) ?? null;
                setTarget(next);
                if (next) {
                  setName(next.name);
                  setDestination(next.folderId ?? "");
                }
              }}
            >
              <option value="">New file</option>
              {published.map((file) => (
                <option key={file.fileId} value={file.fileId}>
                  Update {file.name} · Version {file.version.versionNumber}
                </option>
              ))}
            </select>
            {!target ? (
              <>
                <Label htmlFor="project-save-kind">Save as</Label>
                <select
                  id="project-save-kind"
                  className={SELECT}
                  value={kind}
                  disabled={disabled}
                  onChange={(event) =>
                    setKind(event.target.value as typeof kind)
                  }
                >
                  <option value="published">Published file</option>
                  <option value="draft">Draft for review</option>
                </select>
              </>
            ) : (
              <p className="text-sm text-on-surface-variant">
                This update will be a draft based on version{" "}
                {target.version.versionNumber}. Promotion checks for newer
                changes.
              </p>
            )}
            {target &&
            published.find((file) => file.fileId === target.fileId)?.version
              .versionId !== target.version.versionId ? (
              <p role="status" className="text-sm text-on-surface-variant">
                The target changed since you selected it. This draft keeps
                version {target.version.versionNumber} as its base and may need
                reconciliation before promotion. To start from the current
                version, choose New file, then select the target again.
              </p>
            ) : null}
            <Button
              className="self-start"
              size="sm"
              disabled={disabled || !source || !name.trim()}
            >
              {mutation.isPending
                ? "Saving..."
                : target || kind === "draft"
                  ? "Save draft"
                  : "Save file"}
            </Button>
          </form>
        </div>
      </details>
      {preview ? (
        <VersionPreview
          key={`${preview.file.fileId}:${preview.version.versionId}`}
          projectId={project.projectId}
          {...preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </section>
  );
}
