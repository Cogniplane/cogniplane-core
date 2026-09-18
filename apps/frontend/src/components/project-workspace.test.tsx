// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "./project-workspace";
import * as api from "../lib/project-api";
import { listSessions } from "../lib/session-api";

import type { Artifact, Project, Session } from "@cogniplane/shared-types";
vi.mock("./project-files", () => ({ ProjectFiles: ({ project }: { project: Project }) => <div data-testid="project-files">{project.archivedAt ? "Archived file library" : "File library"}</div> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../lib/project-api", () => ({
  getProject: vi.fn(),
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
vi.mock("../lib/session-api", () => ({ listSessions: vi.fn() }));
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
  vi.mocked(api.getProjectAccess).mockResolvedValue({
    visibility: "private",
    organizationRole: "viewer",
    members: []
  });
  vi.mocked(listSessions).mockResolvedValue([
    session,
    { ...session, sessionId: "s2", projectId: null, sessionName: "Draft" }
  ]);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});
async function open() {
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkspace project={project} />
    </QueryClientProvider>
  );
  await screen.findByText("File library");
}
it("adds an existing session only after disclosure confirmation ", async () => {
  await open();
  fireEvent.change(screen.getByRole("combobox", { name: "Existing session" }), {
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
  await open();
  fireEvent.change(screen.getByRole("combobox", { name: "Approval mode" }), {
    target: { value: "manual" }
  });
  await waitFor(() => expect(api.updateProjectApprovalMode).toHaveBeenCalledWith("p1", "manual"));
  expect(screen.getByText(/Changes apply to new turns/)).toBeTruthy();
});

it("lets the owner choose automatic approval and explains organization limits", async () => {
  vi.mocked(api.updateProjectApprovalMode).mockResolvedValue({ ...project, approvalMode: "automatic" });
  await open();
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
  await open();
  fireEvent.change(screen.getByRole("combobox", { name: "File mode" }), {
    target: { value: "read-write" }
  });
  await waitFor(() => expect(api.updateProjectAgentFileMode).toHaveBeenCalledWith("p1", "read-write"));
  expect(screen.getByText(/New turns use this mode/)).toBeTruthy();
});

it("lets the owner choose an agent file mode and explains that it affects new turns", async () => {
  vi.mocked(api.updateProjectAgentFileMode).mockResolvedValue({ ...project, agentFileMode: "read-write" });
  await open();
  fireEvent.change(screen.getByRole("combobox", { name: "File mode" }), {
    target: { value: "read-write" }
  });
  await waitFor(() => expect(api.updateProjectAgentFileMode).toHaveBeenCalledWith("p1", "read-write"));
  expect(screen.getByText(/New turns use this mode/)).toBeTruthy();
});

it("passes archived state to the file library and lets the owner restore the project", async () => {
  vi.mocked(api.getProject).mockResolvedValue({ project: { ...project, archivedAt: time }, sessions: [session], files: [], canManage: true });
  render(<QueryClientProvider client={client}><ProjectWorkspace project={{ ...project, archivedAt: time }} /></QueryClientProvider>);
  await screen.findByText("Archived file library");
  expect(screen.getByRole("combobox", { name: "Existing session" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Restore project" }));
  await waitFor(() => expect(api.archiveProject).toHaveBeenCalledWith("p1", false));
});

it("does not hide owner controls when the members request fails", async () => {
  vi.mocked(api.getProjectAccess).mockRejectedValue(new Error("Owner access required"));
  await open();
  expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Archive project" })).toBeTruthy();
});

it("uses the project detail capability to hide owner controls for non-owners", async () => {
  vi.mocked(api.getProject).mockResolvedValue({
    project,
    sessions: [session],
    files: [],
    canManage: false
  });
  await open();
  expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Archive project" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
});

it("offers only active unassigned conversations and never offers moves or detachment", async () => {
  vi.mocked(listSessions).mockResolvedValue([
    session,
    { ...session, sessionId: "other", projectId: "p2", sessionName: "Other project conversation" },
    { ...session, sessionId: "archived", projectId: null, status: "archived", sessionName: "Archived conversation" },
    { ...session, sessionId: "scheduled", projectId: null, purpose: "scheduled", sessionName: "Scheduled job" },
    { ...session, sessionId: "free", projectId: null, sessionName: "Private conversation" }
  ]);
  await open();
  const options = within(screen.getByRole("combobox", { name: "Existing session" })).getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual(["Add an existing session...", "Private conversation"]);
  expect(screen.queryByRole("button", { name: "Remove from project" })).toBeNull();
});

it("preserves the confirmation on failure and lets the user retry", async () => {
  vi.mocked(api.setProjectSession).mockRejectedValueOnce(new Error("The session changed. Reload and try again."));
  await open();
  fireEvent.change(screen.getByLabelText("Existing session"), { target: { value: "s2" } });
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
  fireEvent.change(screen.getByLabelText("Existing session"), { target: { value: "s2" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  vi.mocked(listSessions).mockResolvedValue([session]);
  await client.invalidateQueries({ queryKey: ["sessions"] });
  await screen.findByText("This session is no longer available. Cancel and choose another session.");
  expect(screen.getByRole("button", { name: "Confirm addition" }).hasAttribute("disabled")).toBe(true);
  expect(api.setProjectSession).not.toHaveBeenCalled();
});
