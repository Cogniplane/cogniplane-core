import { beforeEach, expect, it, vi } from "vitest";
import { request } from "./api-client";
import { archiveProject, createProjectSession, getProjectAccess, listProjects, setProjectSession, updateProjectAgentFileMode, updateProjectApprovalMode, updateProjectSharing } from "./project-api";
vi.mock("./api-client", () => ({ request: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("omits blank search terms and URL-encodes nonempty query parameters", async () => {
  vi.mocked(request).mockResolvedValue({ projects: [] });
  await listProjects({ q: "  " });
  expect(request).toHaveBeenLastCalledWith("/projects?archived=false");
  await listProjects({ archived: true, q: " 100%_plan " });
  expect(request).toHaveBeenLastCalledWith("/projects?archived=true&q=100%25_plan");
});

it("rejects a project response missing its archive state", async () => {
  vi.mocked(request).mockResolvedValue({
    projects: [
      {
        projectId: "p1",
        name: "Planning",
        referenceSessionId: "refs",
        createdAt: "2026-09-13T00:00:00Z",
        updatedAt: "2026-09-13T00:00:00Z"
      }
    ]
  });
  await expect(listProjects()).rejects.toThrow();
});

it("propagates mutation failures and accepts empty successful responses", async () => {
  vi.mocked(request).mockRejectedValueOnce(new Error("Storage cleanup failed"));
  await expect(archiveProject("p1", true)).rejects.toThrow("Storage cleanup failed");
  vi.mocked(request).mockResolvedValue(undefined);
  await expect(archiveProject("p1", true)).resolves.toBeUndefined();
});

it("sends the audience confirmation when assigning a private conversation", async () => {
  await setProjectSession("p1", "s1");
  expect(request).toHaveBeenCalledWith("/projects/p1/sessions", {
    method: "PUT",
    body: JSON.stringify({ sessionId: "s1", confirmAudience: true })
  });
});

it("preserves the requested name when creating a project session", async () => {
  vi.mocked(request).mockResolvedValue({
    session: {
      sessionId: "s1",
      projectId: "p1",
      userId: "u1",
      sessionName: "Research sprint",
      status: "active",
      createdAt: "2026-09-13T00:00:00Z",
      updatedAt: "2026-09-13T00:00:00Z"
    }
  });
  await createProjectSession("p1", "Research sprint");
  expect(request).toHaveBeenCalledWith("/projects/p1/sessions", {
    method: "POST",
    body: JSON.stringify({ name: "Research sprint" })
  });
});

it("updates the project approval mode through the project endpoint", async () => {
  vi.mocked(request).mockResolvedValue({
    projectId: "p1",
    name: "Planning",
    instructions: "",
    instructionsRevision: 0,
    referenceSessionId: "refs",
    approvalMode: "manual",
    agentFileMode: "read-only",
    archivedAt: null,
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z"
  });
  await updateProjectApprovalMode("p1", "manual");
  expect(request).toHaveBeenCalledWith("/projects/p1/approval-mode", {
    method: "PUT",
    body: JSON.stringify({ approvalMode: "manual" })
  });
});

it("parses automatic project approval mode responses", async () => {
  vi.mocked(request).mockResolvedValue({
    projectId: "p1",
    name: "Planning",
    instructions: "",
    instructionsRevision: 0,
    referenceSessionId: "refs",
    approvalMode: "automatic",
    agentFileMode: "read-only",
    archivedAt: null,
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z"
  });
  await expect(updateProjectApprovalMode("p1", "automatic")).resolves.toMatchObject({
    approvalMode: "automatic"
  });
});

it("updates the project agent file mode through the project endpoint", async () => {
  vi.mocked(request).mockResolvedValue({
    projectId: "p1",
    name: "Planning",
    instructions: "",
    instructionsRevision: 0,
    referenceSessionId: "refs",
    approvalMode: "organization_default",
    agentFileMode: "create-only",
    archivedAt: null,
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z"
  });
  await updateProjectAgentFileMode("p1", "create-only");
  expect(request).toHaveBeenCalledWith("/projects/p1/agent-file-mode", {
    method: "PUT",
    body: JSON.stringify({ agentFileMode: "create-only" })
  });
});

it("loads and updates project sharing through the project endpoints", async () => {
  vi.mocked(request).mockResolvedValueOnce({
    visibility: "private",
    organizationRole: "viewer",
    members: [{ userId: "u1", role: "owner", displayName: "Owner", email: "owner@example.com" }]
  });
  await expect(getProjectAccess("p1")).resolves.toMatchObject({ visibility: "private" });
  await updateProjectSharing("p1", {
    visibility: "organization",
    organizationRole: "editor",
    confirmAudience: true
  });
  expect(request).toHaveBeenLastCalledWith("/projects/p1/sharing", {
    method: "PUT",
    body: JSON.stringify({ visibility: "organization", organizationRole: "editor", confirmAudience: true })
  });
});
