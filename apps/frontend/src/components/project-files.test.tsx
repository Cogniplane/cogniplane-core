// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { Project, ProjectFile, Artifact } from "@cogniplane/shared-types";
import { ProjectFiles } from "./project-files";
import * as api from "../lib/project-file-api";
import * as projectApi from "../lib/project-api";
import * as apiClient from "../lib/api-client";
import { uploadArtifact } from "../lib/artifact-api";
const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("../lib/artifact-api", () => ({ uploadArtifact: vi.fn() }));
vi.mock("../lib/api-client", () => ({
  fetchModels: vi.fn(async () => ({
    models: [],
    showEffortSelector: false,
    enabledToolIds: ["project_get_conflict_context", "project_reconcile_conflict"]
  }))
}));
vi.mock("../lib/project-file-api", () => ({
  getProjectLibrary: vi.fn(),
  saveProjectFile: vi.fn(),
  promoteProjectDraft: vi.fn(),
  changeProjectFileLocation: vi.fn(),
  trashProjectFile: vi.fn(),
  createProjectFolder: vi.fn(),
  renameProjectFolder: vi.fn(),
  removeProjectFolder: vi.fn(),
  getProjectFileHistory: vi.fn(),
  restoreProjectFileVersion: vi.fn(),
  getProjectVersionBlob: vi.fn(),
  getProjectVersionPdfText: vi.fn(),
}));
vi.mock("../lib/project-api", () => ({ createProjectSession: vi.fn() }));
vi.mock("./artifact-preview-modal", () => ({
  ArtifactPreviewModal: (props: {
    artifactName: string;
    content: string | null;
    error: string | null;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={props.artifactName}>
      {props.error ?? props.content ?? "Loading preview"}
      <button onClick={props.onClose}>Close preview</button>
    </div>
  ),
}));
const time = "2026-09-14T00:00:00Z";
const project: Project = {
  projectId: "p",
  referenceSessionId: "r",
  approvalMode: "organization_default",
  agentFileMode: "read-only",
  name: "Planning",
  instructions: "",
  instructionsRevision: 0,
  archivedAt: null,
  createdAt: time,
  updatedAt: time,
};
const published: ProjectFile = {
  fileId: "f",
  folderId: null,
  name: "Brief.txt",
  kind: "published",
  targetFileId: null,
  baseVersionId: null,
  createdByType: "user",
  trashedAt: null,
  updatedAt: time,
  version: {
    versionId: "v1",
    fileId: "f",
    versionNumber: 1,
    mimeType: "text/plain",
    fileSizeBytes: 5,
    checksumSha256: "hash",
    createdBy: "u",
    createdAt: time,
    restoredFromVersionId: null,
  },
};
const draft: ProjectFile = {
  ...published,
  fileId: "d",
  name: "Proposal.txt",
  folderId: "folder",
  kind: "draft",
  createdByType: "agent",
  targetFileId: "f",
  baseVersionId: "v1",
  version: { ...published.version, fileId: "d", versionId: "draft-v1" },
};
const source = {
  artifactId: "a",
  artifactName: "Output.txt",
  status: "ready",
  artifactType: "generated",
  detail: {},
} as Artifact;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.fetchModels).mockResolvedValue({
    models: [],
    showEffortSelector: false,
    enabledToolIds: ["project_get_conflict_context", "project_reconcile_conflict"]
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(api.getProjectLibrary).mockResolvedValue({
    files: [published, draft],
    folders: [
      { folderId: "folder", parentId: null, name: "Research", deletedAt: null },
    ],
  });
  vi.mocked(api.getProjectFileHistory).mockResolvedValue([published.version]);
});
afterEach(() => {
  cleanup();
  client.clear();
});
async function open(current = project) {
  render(
    <QueryClientProvider client={client}>
      <ProjectFiles project={current} sources={[source]} />
    </QueryClientProvider>,
  );
  await screen.findByText("Brief.txt");
}
it("uploads to the project reference session and waits for checks before publishing a participant's file", async () => {
  const pending: Artifact = { ...source, artifactId: "upload", artifactType: "upload",
    artifactName: "Report.txt", userId: "another-participant", status: "pending", detail: { pii: { status: "pending" } } };
  vi.mocked(uploadArtifact).mockResolvedValue(pending);
  vi.mocked(api.saveProjectFile).mockResolvedValue(published);
  const view = (sources: Artifact[]) => <QueryClientProvider client={client}>
    <ProjectFiles project={project} sources={sources} />
  </QueryClientProvider>;
  const rendered = render(view([]));
  await screen.findByText("Brief.txt");
  fireEvent.click(screen.getByText("Add a file or draft"));
  const file = new File(["Report"], "Report.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Upload a file"), { target: { files: [file] } });
  await waitFor(() => expect(uploadArtifact).toHaveBeenCalledWith({ sessionId: "r", file }));
  await screen.findByText(/The selected file is not ready/);
  rendered.rerender(view([pending]));
  fireEvent.submit(screen.getByRole("form", { name: "Save project file" }));
  expect(api.saveProjectFile).not.toHaveBeenCalled();
  rendered.rerender(view([{ ...pending, status: "ready", detail: { pii: { status: "scanned" } } }]));
  await waitFor(() => expect((screen.getByLabelText("Source file") as HTMLSelectElement).value).toBe("upload"));
  fireEvent.submit(screen.getByRole("form", { name: "Save project file" }));
  await waitFor(() => expect(api.saveProjectFile).toHaveBeenCalledWith("p", expect.objectContaining({
    artifactId: "upload", name: "Report.txt", kind: "published",
  })));
});
it("keeps drafts project-wide and promotes only after an explicit action", async () => {
  await open();
  expect(screen.queryByText("Proposal.txt")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  await screen.findByText("Proposal.txt");
  expect(api.promoteProjectDraft).not.toHaveBeenCalled();
  expect(screen.getByText(/Files \/ Research/, { selector: "p" })).toBeTruthy();
  vi.mocked(api.promoteProjectDraft).mockRejectedValue(
    new Error("The published file changed. Your draft is preserved."),
  );
  fireEvent.click(screen.getByRole("button", { name: "Promote draft" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Proposal.txt")).toBeTruthy();
  expect(api.promoteProjectDraft).toHaveBeenCalledWith("p", "d");
});
it("offers an agent conflict resolution session only when the published target advanced", async () => {
  vi.mocked(api.getProjectLibrary).mockResolvedValue({
    files: [
      { ...draft, baseVersionId: "v1" },
      { ...published, version: { ...published.version, versionId: "v2", versionNumber: 2 } },
    ],
    folders: [],
  });
  const current: Project = { ...project, agentFileMode: "read-write" };
  vi.mocked(projectApi.createProjectSession).mockResolvedValue({ sessionId: "resolve-session" } as never);
  await open(current);
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  const resolve = await screen.findByRole("button", { name: "Resolve with agent" });
  fireEvent.click(resolve);
  await waitFor(() => expect(projectApi.createProjectSession).toHaveBeenCalledWith("p", "Resolve Proposal.txt"));
  expect(routerPush).toHaveBeenCalledWith("/?session=resolve-session&resolveDraft=d");
});
it("hides conflict resolution when either managed tool is disabled", async () => {
  vi.mocked(apiClient.fetchModels).mockResolvedValue({
    models: [],
    showEffortSelector: false,
    enabledToolIds: ["project_get_conflict_context"]
  });
  vi.mocked(api.getProjectLibrary).mockResolvedValue({
    files: [
      { ...draft, baseVersionId: "v1" },
      { ...published, version: { ...published.version, versionId: "v2", versionNumber: 2 } },
    ],
    folders: [],
  });
  await open({ ...project, agentFileMode: "read-write" });
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  expect(screen.queryByRole("button", { name: "Resolve with agent" })).toBeNull();
});
it("opens the existing preview with the selected immutable version", async () => {
  vi.mocked(api.getProjectVersionBlob).mockResolvedValue({
    text: async () => "Original content",
  } as Blob);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Original content");
  expect(api.getProjectVersionBlob).toHaveBeenCalledWith("p", "f", "v1");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Close preview" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("leaves Office files download-only and surfaces preview failures", async () => {
  vi.mocked(api.getProjectLibrary).mockResolvedValue({
    files: [
      {
        ...published,
        version: {
          ...published.version,
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      },
    ],
    folders: [],
  });
  await open();
  expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
});
it("saves updates as drafts with the version selected when the form was filled", async () => {
  await open();
  fireEvent.click(screen.getByText("Add a file or draft"));
  fireEvent.change(screen.getByLabelText("Source file"), {
    target: { value: "a" },
  });
  fireEvent.change(screen.getByLabelText("New file or update"), {
    target: { value: "f" },
  });
  vi.mocked(api.getProjectLibrary).mockResolvedValue({
    files: [
      {
        ...published,
        version: { ...published.version, versionId: "v2", versionNumber: 2 },
      },
    ],
    folders: [],
  });
  await client.invalidateQueries({ queryKey: ["projects"] });
  expect(
    await screen.findByText(/The target changed since you selected it/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(api.saveProjectFile).toHaveBeenCalledWith("p", {
      artifactId: "a",
      name: "Brief.txt",
      folderId: null,
      kind: "draft",
      targetFileId: "f",
      baseVersionId: "v1",
    }),
  );
});
it("requires confirmation for Trash and a destination choice for restore", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
  expect(api.trashProjectFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() =>
    expect(api.trashProjectFile).toHaveBeenCalledWith("p", "f"),
  );
  vi.mocked(api.getProjectLibrary).mockResolvedValue({
    files: [{ ...published, folderId: "deleted", trashedAt: time }],
    folders: [],
  });
  await client.invalidateQueries({ queryKey: ["projects"] });
  fireEvent.click(screen.getByRole("button", { name: "Trash" }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore file" }));
  expect(
    screen
      .getByRole("button", { name: "Confirm restore" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(
    within(screen.getByRole("form", { name: "File location" })).getByLabelText(
      "Destination folder",
    ),
    { target: { value: "" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));
  await waitFor(() =>
    expect(api.changeProjectFileLocation).toHaveBeenCalledWith(
      "p",
      "f",
      { name: "Brief.txt", folderId: null },
      "restore",
    ),
  );
});
it("keeps archived project files readable while disabling mutations", async () => {
  await open({ ...project, archivedAt: time });
  expect(
    screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled"),
  ).toBe(false);
  expect(
    screen
      .getByRole("button", { name: "Move to Trash" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  expect(
    screen
      .getByRole("button", { name: "Promote draft" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("restores history as a new version using the latest displayed version as a guard", async () => {
  const current = {
    ...published,
    version: { ...published.version, versionId: "v2", versionNumber: 2 },
  };
  vi.mocked(api.getProjectLibrary).mockResolvedValue({
    files: [current],
    folders: [],
  });
  vi.mocked(api.getProjectFileHistory).mockResolvedValue([
    current.version,
    published.version,
  ]);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Restore as new version" }),
  );
  await waitFor(() =>
    expect(api.restoreProjectFileVersion).toHaveBeenCalledWith(
      "p",
      "f",
      "v1",
      "v2",
    ),
  );
});
