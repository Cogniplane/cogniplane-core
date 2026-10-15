"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type {
  Artifact,
  Project,
  ProjectFile,
  ProjectFilePickerEntry,
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
import { createProjectSession, listProjectArtifacts } from "@/lib/project-api";
import { hasTargetConflict } from "./project-files.logic";
import {
  FolderBreadcrumbs,
  FolderDestinationPicker,
  useFolderDestination,
} from "./project-folder-picker";
import { queryKeys } from "@/lib/query-keys";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  useProjectFileSelection,
  useProjectFilePicker,
  useProjectFolder,
  useProjectFolders,
  useProjectLibraryFiles,
} from "@/hooks/use-project-library";
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
  initialSources,
  sourcesUpdatedAt,
  canEdit = true,
}: {
  project: Project;
  initialSources: Artifact[];
  sourcesUpdatedAt: number;
  canEdit?: boolean;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const sourcesQuery = useQuery({
    queryKey: queryKeys.projects.artifacts(project.projectId),
    queryFn: ({ signal }) => listProjectArtifacts(project.projectId, signal),
    initialData: initialSources,
    initialDataUpdatedAt: sourcesUpdatedAt,
    staleTime: 10_000,
    refetchInterval: (query) => query.state.data?.some((file) =>
      file.status === "pending" || file.status === "processing" ||
      file.detail?.pii?.status === "pending" || file.detail?.pii?.status === "scanning"
    ) ? 10_000 : false
  });
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
  const [target, setTarget] = useState<ProjectFilePickerEntry | null>(null);
  const [targetSearch, setTargetSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<{
    file: ProjectFile;
    name: string;
    folderId: string;
    asNew: boolean;
  } | null>(null);
  const [removing, setRemoving] = useState<ProjectFile | null>(null);
  const [historyFile, setHistoryFile] = useState<ProjectFile | null>(null);
  // Panels open below the list. Move focus into a panel when it opens, so
  // keyboard and screen reader users reach it.
  const removeConfirmRef = useRef<HTMLButtonElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  const removingId = removing?.fileId;
  const editingId = editing?.file.fileId;
  const historyId = historyFile?.fileId;
  useLayoutEffect(() => { if (removingId) removeConfirmRef.current?.focus(); }, [removingId]);
  useLayoutEffect(() => { if (editingId) editNameRef.current?.focus(); }, [editingId]);
  useLayoutEffect(() => { if (historyId) historyHeadingRef.current?.focus(); }, [historyId]);
  const [preview, setPreview] = useState<{
    file: ProjectFile;
    version: ProjectFileVersion;
  } | null>(null);
  const q = useDebouncedValue(query.trim());
  const targetQ = useDebouncedValue(targetSearch.trim());
  // Published files without a search are scoped to one folder. Drafts, Trash,
  // and search results are project-wide.
  const files = useProjectLibraryFiles(project.projectId, {
    section,
    folderId: section === "published" && !q ? folderId ?? undefined : undefined,
    q: q || undefined,
    sort,
  });
  const childFolders = useProjectFolders(
    project.projectId,
    { parentId: folderId ?? undefined },
    section === "published" && !q,
  );
  const folderDetail = useProjectFolder(project.projectId, folderId);
  const currentFolder = folderDetail.data?.folder.deletedAt
    ? undefined
    : folderDetail.data?.folder;
  const targets = useProjectFilePicker(
    project.projectId,
    { q: targetQ || undefined, kind: "published" },
    addOpen,
  );
  // Loads the current version of the chosen target, even when it is not on a loaded page.
  const targetSelection = useProjectFileSelection(
    project.projectId,
    target ? [target.fileId] : [],
  );
  const targetNow = targetSelection.data?.items.find(
    (entry) => entry.fileId === target?.fileId,
  );
  const targetGone =
    Boolean(target) &&
    targetSelection.isSuccess &&
    !targetSelection.isPlaceholderData &&
    !targetNow;
  const editDestination = useFolderDestination(
    project.projectId,
    editing?.folderId ?? "",
  );
  const saveDestination = useFolderDestination(project.projectId, destination);
  const history = useQuery({
    queryKey: ["projects", project.projectId, "history", historyFile?.fileId],
    queryFn: () =>
      api.getProjectFileHistory(project.projectId, historyFile!.fileId),
    enabled: Boolean(historyFile),
  });
  const readySources = (sourcesQuery.data ?? initialSources).filter(
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
  const visible = files.items;
  const canResolveConflict = (file: (typeof visible)[number]) => {
    const enabledToolIds = capabilitiesQuery.data?.enabledToolIds ?? [];
    if (!enabledToolIds.includes("project_get_conflict_context") || !enabledToolIds.includes("project_reconcile_conflict")) return false;
    if (project.agentFileMode !== "read-write" || !hasTargetConflict(file)) return false;
    return isTextReadableArtifact(file.version.mimeType);
  };
  const openFolder = (next: string | null) => {
    setFolderId(next);
    setRenamingFolder(false);
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
  // The loaded row refreshes after mutations. Fall back to the version shown
  // when the history opened if the row is no longer on a loaded page.
  const historyVersionId = historyFile
    ? (visible.find((file) => file.fileId === historyFile.fileId)?.version
        .versionId ?? historyFile.version.versionId)
    : null;
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
      {files.query.isPending ? <Skeleton className="h-32" /> : null}
      {files.query.isError ? (
        <div role="alert">
          <p>Could not load project files.</p>
          <Button variant="outline" onClick={() => void files.query.refetch()}>
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
            <FolderBreadcrumbs
              detail={folderId ? folderDetail.data : undefined}
              onNavigate={openFolder}
            />
            {folderId ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!folderDetail.data}
                  onClick={() => openFolder(folderDetail.data?.folder.parentId ?? null)}
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
                      openFolder(currentFolder?.parentId ?? null);
                    })
                  }
                >
                  Remove empty folder
                </Button>
              </>
            ) : null}
          </nav>
          {folderId && folderDetail.data?.folder.deletedAt ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
              This folder was removed.
              <Button
                size="xs"
                variant="outline"
                onClick={() => openFolder(folderDetail.data?.nearestLiveFolderId ?? null)}
              >
                Go to nearest folder
              </Button>
            </div>
          ) : null}
          {folderId && folderDetail.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
              Could not open this folder.
              <Button size="xs" variant="outline" onClick={() => openFolder(null)}>
                Go to Files
              </Button>
            </div>
          ) : null}
          {!q ? (
            <div className="flex flex-wrap gap-2">
              {childFolders.items.map((folder) => (
                <Button
                  key={folder.folderId}
                  size="sm"
                  variant="outline"
                  onClick={() => openFolder(folder.folderId)}
                >
                  {folder.name} /
                </Button>
              ))}
              {childFolders.query.hasNextPage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={childFolders.query.isFetchingNextPage}
                  onClick={() => void childFolders.query.fetchNextPage()}
                >
                  {childFolders.query.isFetchingNextPage ? "Loading..." : "More folders"}
                </Button>
              ) : null}
              {childFolders.query.isError ? (
                <p role="alert" className="text-sm text-danger">
                  Could not load folders.{" "}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void childFolders.query.refetch()}
                  >
                    Try again
                  </Button>
                </p>
              ) : null}
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
      {files.query.isSuccess && visible.length === 0 ? (
        <p className="text-sm text-on-surface-variant">
          {q
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
                {file.folderPath} · Version{" "}
                {file.version.versionNumber} ·{" "}
                {formatFileSize(file.version.fileSizeBytes)}
              </p>
              <p className="text-xs text-on-surface-variant">
                Created by {file.createdByType === "agent" ? "an agent" : "a person"}
              </p>
              {file.targetFileId ? (
                <p className="text-xs text-on-surface-variant">
                  {file.target
                    ? `Updates ${file.target.name}${file.target.available ? "" : " (no longer published)"}`
                    : "Updates an unavailable file"}
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
                              await client.invalidateQueries({ queryKey: queryKeys.sessions.list() });
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
      {files.listChanged ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
          <p>Files changed while you scrolled. Reload the list.</p>
          <Button size="sm" variant="outline" onClick={() => void files.reload()}>
            Reload list
          </Button>
        </div>
      ) : null}
      {files.query.hasNextPage ? (
        <Button
          className="self-start"
          size="sm"
          variant="outline"
          disabled={files.query.isFetchingNextPage}
          onClick={() => void files.query.fetchNextPage()}
        >
          {files.query.isFetchingNextPage ? "Loading..." : "More files"}
        </Button>
      ) : null}
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
              ref={removeConfirmRef}
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
            ref={editNameRef}
            id="project-file-name"
            value={editing.name}
            maxLength={255}
            onChange={(event) =>
              setEditing({ ...editing, name: event.target.value })
            }
          />
          <FolderDestinationPicker
            projectId={project.projectId}
            label="Destination folder"
            value={editing.folderId}
            onChange={(next) => setEditing({ ...editing, folderId: next })}
          />
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
                editDestination.status !== "live"
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
            <h4 ref={historyHeadingRef} tabIndex={-1} className="text-sm font-semibold">
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
              version.versionId !== historyVersionId ? (
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
                        historyVersionId!,
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
      <details
        className="border-t border-outline-variant pt-4"
        onToggle={(event) => setAddOpen(event.currentTarget.open)}
      >
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
                  baseVersionId: target?.versionId ?? null,
                });
                setName("");
                setSourceId("");
                setTarget(null);
                setTargetSearch("");
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
            {addOpen ? (
              <FolderDestinationPicker
                projectId={project.projectId}
                label="Destination folder"
                value={destination}
                disabled={disabled}
                onChange={setDestination}
              />
            ) : null}
            <Label htmlFor="project-save-target">New file or update</Label>
            <Input
              aria-label="Search published files to update"
              placeholder="Search published files"
              value={targetSearch}
              disabled={disabled}
              onChange={(event) => setTargetSearch(event.target.value)}
            />
            <div className="flex gap-2">
              <select
                id="project-save-target"
                className={SELECT}
                value={target?.fileId ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  const next =
                    [target, ...targets.items].find(
                      (entry) => entry?.fileId === event.target.value,
                    ) ?? null;
                  setTarget(next);
                  if (next) {
                    setName(next.name);
                    setDestination(next.folderId ?? "");
                  }
                }}
              >
                <option value="">New file</option>
                {target &&
                !targets.items.some((entry) => entry.fileId === target.fileId) ? (
                  <option value={target.fileId}>
                    Update {target.name} · Version {target.versionNumber}
                  </option>
                ) : null}
                {targets.items.map((entry) => (
                  <option key={entry.fileId} value={entry.fileId}>
                    Update {entry.name} · Version {entry.versionNumber}
                  </option>
                ))}
              </select>
              {targets.query.hasNextPage ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={targets.query.isFetchingNextPage}
                  onClick={() => void targets.query.fetchNextPage()}
                >
                  {targets.query.isFetchingNextPage ? "Loading..." : "More results"}
                </Button>
              ) : null}
            </div>
            {targets.query.isError ? (
              <p role="alert" className="text-sm text-danger">
                Could not load published files.
              </p>
            ) : null}
            {targetQ && targets.query.isSuccess && targets.items.length === 0 ? (
              <p className="text-sm text-on-surface-variant">
                No published files match your search.
              </p>
            ) : null}
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
                {target.versionNumber}. Promotion checks for newer changes.
              </p>
            )}
            {target && targetNow && targetNow.versionId !== target.versionId ? (
              <p role="status" className="text-sm text-on-surface-variant">
                The target changed since you selected it. This draft keeps
                version {target.versionNumber} as its base and may need
                reconciliation before promotion. To start from the current
                version, choose New file, then select the target again.
              </p>
            ) : null}
            {targetGone ? (
              <p role="status" className="text-sm text-danger">
                The target file is no longer published. Choose New file or
                another file to update.
              </p>
            ) : null}
            <Button
              className="self-start"
              size="sm"
              disabled={
                disabled ||
                !source ||
                !name.trim() ||
                targetGone ||
                saveDestination.status !== "live"
              }
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
