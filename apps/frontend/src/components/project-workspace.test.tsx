// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ProjectWorkspace } from "./project-workspace";
import * as api from "../lib/project-api";
import { listSessions, restoreSession, archiveSession, deleteSession, interruptSession } from "../lib/session-api";

import type { Artifact, Project, Session } from "@cogniplane/shared-types";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./project-files", () => ({ ProjectFiles: ({ project }: { project: Project }) => <div data-testid="project-files">{project.archivedAt ? "Archived file library" : "File library"}</div> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "t1", userId: "u" } }) }));
vi.mock("./project-skills", () => ({ ProjectSkills: ({ projectName }: { projectName: string }) => <div data-testid="project-skills">Project skills in {projectName}</div> }));
vi.mock("../lib/project-api", () => ({
  getProject: vi.fn(),
  getProjectCapabilities: vi.fn(),
  updateProjectCapabilities: vi.fn(),
  listProjectSessions: vi.fn(),
  renameProject: vi.fn(),
  setProjectSession: vi.fn(),
  createProjectSession: vi.fn(),
  archiveProject: vi.fn(),
  updateProjectApprovalMode: vi.fn(),
  updateProjectAgentFileMode: vi.fn(),
  getProjectAccess: vi.fn(),
  updateProjectSharing: vi.fn(),
}));
vi.mock("./project-sharing", () => ({ ProjectSharing: () => <div data-testid="project-sharing" /> }));
vi.mock("../lib/session-api", () => ({
  listSessions: vi.fn(),
  restoreSession: vi.fn(),
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  interruptSession: vi.fn()
}));
vi.mock("../lib/artifact-api", () => ({
  uploadArtifact: vi.fn(),
  createArtifactDownload: vi.fn()
}));
const time = "2026-09-13T00:00:00Z";
const project: Project = {
  projectId: "p1",
  archivedAt: null,
  instructions: "",
  instructionsRevision: 0,
  name: "Planning",
  referenceSessionId: "refs",
  approvalMode: "organization_default",
  agentFileMode: "read-only",
  createdAt: time,
  updatedAt: time
};
const session: Session = {
  sessionId: "s1",
  projectId: "p1",
  userId: "u",
  sessionName: "Research",
  status: "active",
  createdAt: time,
  updatedAt: time
};
const reference: Artifact = {
  artifactId: "a1",
  sessionId: "refs",
  userId: "u",
  artifactType: "upload",
  sourceArtifactId: null,
  artifactName: "Brief.txt",
  mimeType: "text/plain",
  storageBackend: "local",
  storageKey: "a1",
  fileSizeBytes: 12,
  checksumSha256: "hash",
  status: "ready",
  createdByType: "user",
  createdByRef: null,
  detail: {},
  createdAt: time,
  updatedAt: time
};
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getProjectCapabilities).mockResolvedValue({ selection: null, version: 1, canEdit: true,
    skills: [], connectors: [] });
  vi.mocked(api.getProject).mockResolvedValue({
    project,
    sessions: [session],
    files: [
      reference,
      {
        ...reference,
        artifactId: "a2",
        sessionId: "s1",
        artifactName: "Report.txt",
        artifactType: "generated"
      }
    ],
    canManage: true
  });
  vi.mocked(api.listProjectSessions).mockImplementation(async (_id, { status }) => ({
    sessions: status === "active" ? [session] : [], nextCursor: null, trashRetentionDays: 30
  }));
  vi.mocked(api.getProjectAccess).mockResolvedValue({
    visibility: "private",
    organizationRole: "viewer",
    members: []
  });
  vi.mocked(listSessions).mockResolvedValue({ trashRetentionDays: 30, sessions: [
    session,
    { ...session, sessionId: "s2", projectId: null, sessionName: "Draft" }
  ] });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});
async function open(view: "overview" | "settings" = "overview") {
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkspace project={project} view={view} />
    </QueryClientProvider>
  );
  await screen.findByText(view === "overview" ? "File library" : "Project settings");
  if (view === "overview") {
    const addSession = screen.queryByText("Add an existing session");
    if (addSession) {
      fireEvent.click(addSession);
      await waitFor(() => expect(screen.queryByText("Loading personal sessions...")).toBeNull());
    }
  }
}

it("keeps everyday project work in Overview and owner controls in Settings", async () => {
  await open();
  expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href"))
    .toBe("/projects?project=p1&archived=false&view=settings");
  expect(screen.getByRole("heading", { name: "Sessions" })).toBeTruthy();
  expect(screen.queryByText("Project settings")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Approval mode" })).toBeNull();
  cleanup();

  await open("settings");
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Overview" }).getAttribute("href"))
    .toBe("/projects?project=p1&archived=false");
  expect(screen.getByRole("combobox", { name: "Approval mode" })).toBeTruthy();
  expect(screen.getByTestId("project-skills").textContent).toBe("Project skills in Planning");
  expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
  expect(screen.queryByText("File library")).toBeNull();
});
it("adds an existing session only after disclosure confirmation ", async () => {
  await open();
  fireEvent.change(screen.getByRole("combobox", { name: "Session to add" }), {
    target: { value: "s2" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const confirmation = screen.getByRole("group", { name: "Confirm session assignment" });
  expect(confirmation.textContent).toContain("conversation history and attachments");
  expect(confirmation.textContent).toContain("cannot be moved to another project or removed");
  expect(api.setProjectSession).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(api.setProjectSession).not.toHaveBeenCalled();
  expect(screen.queryByRole("group", { name: "Confirm session assignment" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" }));
  await waitFor(() => expect(api.setProjectSession).toHaveBeenCalledWith("p1", "s2"));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Confirm session assignment" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Remove from project" })).toBeNull();
});

it("lets the owner choose manual approval and explains that it affects new turns", async () => {
  vi.mocked(api.updateProjectApprovalMode).mockResolvedValue({ ...project, approvalMode: "manual" });
  await open("settings");
  fireEvent.change(screen.getByRole("combobox", { name: "Approval mode" }), {
    target: { value: "manual" }
  });
  await waitFor(() => expect(api.updateProjectApprovalMode).toHaveBeenCalledWith("p1", "manual"));
  expect(screen.getByText(/Changes apply to new turns/)).toBeTruthy();
});

it("keeps the selected approval value visible while saving", async () => {
  let finish!: (value: Project) => void;
  vi.mocked(api.updateProjectApprovalMode).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await open("settings");
  const select = screen.getByRole("combobox", { name: "Approval mode" }) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "manual" } });
  await waitFor(() => expect(select.disabled).toBe(true));
  expect(select.value).toBe("manual");
  expect(select.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("status").textContent).toContain("Saving approval mode");
  finish({ ...project, approvalMode: "manual" });
  await waitFor(() => expect(select.disabled).toBe(false));
});

it("lets the owner choose automatic approval and explains organization limits", async () => {
  vi.mocked(api.updateProjectApprovalMode).mockResolvedValue({ ...project, approvalMode: "automatic" });
  await open("settings");
  vi.mocked(api.getProject).mockResolvedValueOnce({
    project: { ...project, approvalMode: "automatic" },
    sessions: [session],
    files: [],
    canManage: true
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Approval mode" }), {
    target: { value: "automatic" }
  });
  await waitFor(() => expect(api.updateProjectApprovalMode).toHaveBeenCalledWith("p1", "automatic"));
  expect(screen.getByText(/same effective behavior as Organization default/)).toBeTruthy();
});

it("lets the owner choose an agent file mode and explains that it affects new turns", async () => {
  vi.mocked(api.updateProjectAgentFileMode).mockResolvedValue({ ...project, agentFileMode: "read-write" });
  await open("settings");
  fireEvent.change(screen.getByRole("combobox", { name: "File mode" }), {
    target: { value: "read-write" }
  });
  await waitFor(() => expect(api.updateProjectAgentFileMode).toHaveBeenCalledWith("p1", "read-write"));
  expect(screen.getByText(/New turns use this mode/)).toBeTruthy();
});

it("passes archived state to the overview file library", async () => {
  vi.mocked(api.getProject).mockResolvedValue({ project: { ...project, archivedAt: time }, sessions: [session], files: [], canManage: true });
  render(<QueryClientProvider client={client}><ProjectWorkspace project={{ ...project, archivedAt: time }} view="overview" /></QueryClientProvider>);
  await screen.findByText("Archived file library");
  expect(screen.queryByText("Add an existing session")).toBeNull();
  expect(screen.getByText("Restore this project in Settings to start or add sessions.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "New session" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Restore project" })).toBeNull();
});

it("lets the owner restore an archived project from Settings", async () => {
  vi.mocked(api.getProject).mockResolvedValue({ project: { ...project, archivedAt: time }, sessions: [session], files: [], canManage: true });
  render(<QueryClientProvider client={client}><ProjectWorkspace project={{ ...project, archivedAt: time }} view="settings" /></QueryClientProvider>);
  await screen.findByText("Project settings");
  fireEvent.click(screen.getByRole("button", { name: "Restore project" }));
  await waitFor(() => expect(api.archiveProject).toHaveBeenCalledWith("p1", false));
});

it("does not hide owner controls when the members request fails", async () => {
  vi.mocked(api.getProjectAccess).mockRejectedValue(new Error("Owner access required"));
  await open("settings");
  expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Archive project" })).toBeTruthy();
});

it("uses the project detail capability to prevent owner actions and explain approval access", async () => {
  vi.mocked(api.getProject).mockResolvedValue({
    project,
    sessions: [session],
    files: [],
    canManage: false
  });
  await open("settings");
  expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Archive project" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
  expect((screen.getByRole("combobox", { name: "Approval mode" }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText("Only project owners can change approval mode.")).toBeTruthy();
  expect(api.updateProjectApprovalMode).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox", { name: "File mode" })).toBeNull();
});

it("offers only active unassigned conversations and never offers moves or detachment", async () => {
  vi.mocked(listSessions).mockResolvedValue({ trashRetentionDays: 30, sessions: [
    session,
    { ...session, sessionId: "other", projectId: "p2", sessionName: "Other project conversation" },
    { ...session, sessionId: "archived", projectId: null, status: "archived", sessionName: "Archived conversation" },
    { ...session, sessionId: "scheduled", projectId: null, purpose: "scheduled", sessionName: "Scheduled job" },
    { ...session, sessionId: "free", projectId: null, sessionName: "Private conversation" }
  ] });
  await open();
  const options = within(screen.getByRole("combobox", { name: "Session to add" })).getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual(["Add an existing session...", "Private conversation"]);
  expect(screen.queryByRole("button", { name: "Remove from project" })).toBeNull();
});

it("preserves the confirmation on failure and lets the user retry", async () => {
  vi.mocked(api.setProjectSession).mockRejectedValueOnce(new Error("The session changed. Reload and try again."));
  await open();
  fireEvent.change(screen.getByLabelText("Session to add"), { target: { value: "s2" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" }));
  await screen.findByText("The session changed. Reload and try again.");
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm addition" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" }));
  await waitFor(() => expect(api.setProjectSession).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Confirm session assignment" })).toBeNull());
});

it("blocks confirmation when a refreshed session list shows the session was assigned elsewhere", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Session to add"), { target: { value: "s2" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  vi.mocked(listSessions).mockResolvedValue({ trashRetentionDays: 30, sessions: [session] });
  await client.invalidateQueries({ queryKey: ["sessions"] });
  await screen.findByText("This session is no longer available. Cancel and choose another session.");
  expect(screen.getByRole("button", { name: "Confirm addition" }).hasAttribute("disabled")).toBe(true);
  expect(api.setProjectSession).not.toHaveBeenCalled();
});

it("finds an older personal session through paged search and confirms its assignment", async () => {
  let fail = true;
  vi.mocked(listSessions).mockImplementation(async ({ cursor, search, personalOnly } = {}) => {
    expect(personalOnly).toBe(true);
    if (cursor && fail) throw new Error("Offline");
    return { sessions: cursor || search ? [{ ...session, sessionId: "old-personal", projectId: null, sessionName: "Older planning" }] : [],
      nextCursor: cursor || search ? null : "older", trashRetentionDays: 30 };
  });
  await open();
  fireEvent.click(await screen.findByRole("button", { name: "Find more personal sessions" }));
  await screen.findByText("Could not load personal sessions to add.");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  const callsBeforeRetry = vi.mocked(listSessions).mock.calls.length;
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("option", { name: "Older planning" });
  expect(vi.mocked(listSessions).mock.calls.slice(callsBeforeRetry).map(([options]) => options?.cursor)).toEqual(["older"]);
  fireEvent.change(screen.getByLabelText("Find a session to add"), { target: { value: "planning" } });
  await screen.findByRole("option", { name: "Older planning" });
  fireEvent.change(screen.getByLabelText("Session to add"), { target: { value: "old-personal" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" }));
  await waitFor(() => expect(api.setProjectSession).toHaveBeenCalledWith(project.projectId, "old-personal"));
});


it("paginates each project session list independently and retries only a failed page", async () => {
  const archived = { ...session, sessionId: "archived-1", sessionName: "Old plan", status: "archived" as const };
  const deleted = { ...session, sessionId: "deleted-1", sessionName: "Discarded plan", status: "deleted" as const };
  vi.mocked(api.getProject).mockResolvedValue({ project, files: [], canManage: true, canEdit: true,
    sessions: [session, archived], sessionCursors: { active: "active-next", archived: "archived-next" },
    trash: { sessions: [deleted], retentionDays: 30, nextCursor: "trash-next" } });
  let fail = true;
  vi.mocked(api.listProjectSessions).mockImplementation(async (_id, { status, cursor }) => {
    if (status === "active" && fail) { fail = false; throw new Error("offline"); }
    expect(cursor).toBe(status === "deleted" ? "trash-next" : `${status}-next`);
    const first = status === "active" ? session : status === "archived" ? archived : deleted;
    return { sessions: [first, { ...first, sessionId: `${status}-older`, sessionName: `${status} older` }],
      nextCursor: null, trashRetentionDays: 30 };
  });
  await open();
  expect(api.listProjectSessions).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Load more active sessions" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Could not load active sessions"));
  expect(screen.getAllByRole("link", { name: "Research" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry active sessions" }));
  await screen.findByRole("link", { name: "active older" });
  expect(screen.getAllByRole("link", { name: "Research" })).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more active sessions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  fireEvent.click(screen.getByRole("button", { name: "Load more archived sessions" }));
  await screen.findByRole("link", { name: "archived older" });
  fireEvent.click(screen.getByRole("button", { name: "Load more Trash sessions" }));
  await screen.findByText("deleted older");
  expect(api.listProjectSessions).toHaveBeenCalledTimes(4);
  expect(vi.mocked(api.listProjectSessions).mock.calls.map(([id, { status, cursor }]) => [id, status, cursor]))
    .toEqual([["p1", "active", "active-next"], ["p1", "active", "active-next"],
      ["p1", "archived", "archived-next"], ["p1", "deleted", "trash-next"]]);
  fireEvent.click(screen.getByRole("button", { name: "Active" }));
  expect(screen.getByRole("link", { name: "active older" })).toBeTruthy();
});

it("hides cached Trash rows after editor access is lost", async () => {
  const detail = { project, files: [], canManage: false, canEdit: true, sessions: [session],
    trash: { sessions: [{ ...session, status: "deleted" as const, sessionName: "Private trash" }],
      retentionDays: 30, nextCursor: "next" } };
  vi.mocked(api.getProject).mockResolvedValue(detail);
  await open();
  expect(screen.getByText("Private trash")).toBeTruthy();
  vi.mocked(api.getProject).mockResolvedValue({ ...detail, canEdit: false, trash: { sessions: [], retentionDays: 30, nextCursor: null } });
  await client.invalidateQueries({ queryKey: ["projects", "p1"], exact: true });
  await waitFor(() => expect(screen.queryByText("Private trash")).toBeNull());
  expect(screen.queryByRole("button", { name: "Load more Trash sessions" })).toBeNull();
});


it("refreshes loaded pages after restoring an older Trash session", async () => {
  const deleted = { ...session, sessionId: "deleted-1", status: "deleted" as const, sessionName: "Deleted first" };
  const older = { ...deleted, sessionId: "deleted-2", sessionName: "Deleted older" };
  vi.mocked(api.getProject).mockResolvedValue({ project, files: [], canManage: true, sessions: [session],
    trash: { sessions: [deleted], retentionDays: 30, nextCursor: "next" } });
  let restored = false;
  vi.mocked(api.listProjectSessions).mockImplementation(async (_id, { status, cursor }) => ({
    sessions: status === "active" ? [session, ...(restored ? [{ ...older, status: "active" as const }] : [])]
      : status === "deleted" ? cursor ? restored ? [] : [older] : [deleted] : [],
    nextCursor: status === "deleted" && !cursor ? "next" : null, trashRetentionDays: 30
  }));
  vi.mocked(restoreSession).mockImplementation(async () => { restored = true; return { ...older, status: "active" }; });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Load more Trash sessions" }));
  const row = (await screen.findByText("Deleted older")).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Restore session" }));
  await screen.findByRole("link", { name: "Deleted older" });
  expect(restoreSession).toHaveBeenCalledWith("deleted-2");
  const trash = screen.getByRole("region", { name: "Session Trash" });
  expect(within(trash).queryByText("Deleted older")).toBeNull();
  expect(within(trash).getByText("Deleted first")).toBeTruthy();
});


it.each([
  { label: "Archive", action: archiveSession, running: false },
  { label: "Move to Trash", action: deleteSession, running: false },
  { label: "Stop turn", action: interruptSession, running: true }
])("dispatches $label for the selected project session and refreshes its pages", async ({ label, action, running }) => {
  vi.mocked(api.getProject).mockResolvedValue({ project, files: [], canManage: true,
    sessions: [{ ...session, isRunning: running }] });
  await open();
  expect(api.listProjectSessions).not.toHaveBeenCalled();
  const actionName = label === "Move to Trash" ? "Move to Trash: Research" : label === "Stop turn" ? "Stop turn in Research" : label;
  fireEvent.click(screen.getByRole("button", { name: actionName }));
  if (label === "Move to Trash") {
    expect(deleteSession).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: label }));
  }
  await waitFor(() => expect(action).toHaveBeenCalledWith(session.sessionId));
  await waitFor(() => expect(api.listProjectSessions).toHaveBeenCalledWith(project.projectId,
    expect.objectContaining({ status: "active", cursor: undefined })));
  expect(screen.queryByRole("alert")).toBeNull();
});


it("separates finding a personal session from the project's status filter", async () => {
  await open();
  expect(screen.getByRole("group", { name: "Project session status" })).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.getByText(/This search does not filter the project sessions above/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Find a session to add"), { target: { value: "missing" } });
  await waitFor(() => expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ search: "missing", personalOnly: true })));
  expect(screen.getByRole("link", { name: "Research" })).toBeTruthy();
  expect(api.listProjectSessions).not.toHaveBeenCalled();
});

it.each([0, 30])("explains retention %i before any removal and returns focus after cancel", async retentionDays => {
  vi.mocked(api.getProject).mockResolvedValue({ project, files: [], sessions: [session], canManage: true, trash: { sessions: [], retentionDays } });
  await open();
  const opener = screen.getByRole("button", { name: retentionDays ? "Move to Trash: Research" : "Delete permanently: Research" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain('"Research"');
  expect(dialog.textContent).toContain("conversation and local files");
  expect(dialog.textContent).toContain(retentionDays ? "30 days" : "cannot be restored");
  expect(deleteSession).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(deleteSession).not.toHaveBeenCalled();
});

it.each([0, 30])("guards repeated removal at retention %i, reports the outcome, and focuses the list", async retentionDays => {
  let finish!: () => void;
  vi.mocked(api.getProject).mockResolvedValue({ project, files: [], sessions: [session], canManage: true, trash: { sessions: [], retentionDays } });
  vi.mocked(api.listProjectSessions).mockResolvedValue({ sessions: [], nextCursor: null, trashRetentionDays: retentionDays });
  vi.mocked(deleteSession).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await open();
  fireEvent.click(screen.getByRole("button", { name: retentionDays ? "Move to Trash: Research" : "Delete permanently: Research" }));
  const confirm = within(screen.getByRole("alertdialog")).getByRole("button", { name: retentionDays ? "Move to Trash" : "Delete permanently" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(1));
  expect(confirm.hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(toast.success).toHaveBeenCalledWith(retentionDays
    ? "Session moved to Trash. Its conversation and local files can be restored for 30 days."
    : "Session deleted. Its conversation and local files cannot be restored.");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Sessions" })));
});

it("keeps a refused removal decision open and lets the user retry", async () => {
  vi.mocked(deleteSession).mockRejectedValueOnce(new Error("Access refused"));
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Move to Trash: Research" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Move to Trash" }));
  await screen.findByText(/Move to Trash failed.*Access refused/);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(toast.success).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Move to Trash" }));
  await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));
});

it.each([
  { role: "viewer", canManage: false, canEdit: false, archivedAt: null, isRunning: false, hasPendingApprovals: false },
  { role: "archived", canManage: true, canEdit: true, archivedAt: time, isRunning: false, hasPendingApprovals: false },
  { role: "running", canManage: false, canEdit: true, archivedAt: null, isRunning: true, hasPendingApprovals: false },
  { role: "approval", canManage: false, canEdit: true, archivedAt: null, isRunning: false, hasPendingApprovals: true }
])("preserves the $role session removal guard", async fixture => {
  vi.mocked(api.getProject).mockResolvedValue({ project: { ...project, archivedAt: fixture.archivedAt }, files: [], sessions: [{ ...session, isRunning: fixture.isRunning, hasPendingApprovals: fixture.hasPendingApprovals }], canManage: fixture.canManage, canEdit: fixture.canEdit });
  render(<QueryClientProvider client={client}><ProjectWorkspace project={project} /></QueryClientProvider>);
  await screen.findByRole("link", { name: "Research" });
  const button = screen.queryByRole("button", { name: "Move to Trash: Research" });
  if (fixture.role === "viewer") expect(button).toBeNull();
  else { expect(button?.hasAttribute("disabled")).toBe(true); fireEvent.click(button!); }
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(deleteSession).not.toHaveBeenCalled();
});

it("blocks a removal if refreshed permission changes during the decision", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Move to Trash: Research" }));
  vi.mocked(api.getProject).mockResolvedValue({ project, files: [], sessions: [session], canManage: false, canEdit: false });
  await act(async () => { await client.invalidateQueries({ queryKey: ["projects", "p1"], exact: true }); });
  await waitFor(() => expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(true));
  expect(deleteSession).not.toHaveBeenCalled();
});

it.each([
  { role: "viewer", canManage: false, canEdit: false, archivedAt: null,
    help: "You have read-only access. A project owner or editor can start or add sessions." },
  { role: "archived owner", canManage: true, canEdit: true, archivedAt: time,
    help: "Restore this project in Settings to start or add sessions." },
  { role: "archived viewer", canManage: false, canEdit: false, archivedAt: time,
    help: "This project is archived. A project owner must restore it before sessions can be started or added." }
])("explains unavailable session actions for an empty $role project", async fixture => {
  vi.mocked(api.getProject).mockResolvedValue({ project: { ...project, archivedAt: fixture.archivedAt },
    files: [], sessions: [], canManage: fixture.canManage, canEdit: fixture.canEdit });
  vi.mocked(api.listProjectSessions).mockResolvedValue({ sessions: [], nextCursor: null, trashRetentionDays: 30 });
  render(<QueryClientProvider client={client}><ProjectWorkspace project={project} /></QueryClientProvider>);
  await screen.findByText("No active sessions in this project.");
  expect(screen.getByText(fixture.help)).toBeTruthy();
  expect(screen.getByRole("button", { name: "New session" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("Add an existing session")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Find a session to add" })).toBeNull();
  expect(screen.queryByText("Start a session here or add an existing conversation.")).toBeNull();
  expect(listSessions).not.toHaveBeenCalled();
  expect(api.createProjectSession).not.toHaveBeenCalled();
  expect(api.setProjectSession).not.toHaveBeenCalled();
});


it("shows the current saved project name in Settings when detail is newer than the list", async () => {
  vi.mocked(api.getProject).mockResolvedValue({ project: { ...project, name: "Updated planning" }, sessions: [], files: [], canManage: true });
  await open("settings");
  expect(screen.getByRole("heading", { name: "Updated planning" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect((screen.getByLabelText("Rename project") as HTMLInputElement).value).toBe("Updated planning");
});
