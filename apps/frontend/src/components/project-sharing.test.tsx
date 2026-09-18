// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project } from "@cogniplane/shared-types";
import { getProjectAccess, updateProjectSharing } from "@/lib/project-api";
import { ApiError } from "@/lib/api-client";
import { ProjectSharing } from "./project-sharing";

vi.mock("@/lib/project-api", () => ({
  getProjectAccess: vi.fn(),
  updateProjectSharing: vi.fn()
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const project: Project = {
  projectId: "p1",
  name: "Planning",
  instructions: "",
  instructionsRevision: 0,
  referenceSessionId: "refs",
  approvalMode: "organization_default",
  agentFileMode: "read-only",
  archivedAt: null,
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z"
};
let client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  vi.mocked(getProjectAccess).mockResolvedValue({
    visibility: "private",
    organizationRole: "viewer",
    members: [{ userId: "u1", role: "owner", displayName: "Owner", email: "owner@example.com" }]
  });
  vi.mocked(updateProjectSharing).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  client.clear();
});

function renderSharing() {
  return render(
    <QueryClientProvider client={client}>
      <ProjectSharing project={project} />
    </QueryClientProvider>
  );
}

it("explains the audience change before sharing a project", async () => {
  renderSharing();
  const visibility = await screen.findByLabelText("Who can access");
  fireEvent.change(visibility, { target: { value: "organization" } });
  fireEvent.change(screen.getByLabelText("Organization access"), { target: { value: "editor" } });
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));

  expect(screen.getByRole("heading", { name: "Share this project with your organization?" })).toBeTruthy();
  expect(screen.getByText(/existing conversations, attachments, files, and drafts/)).toBeTruthy();
  expect(screen.getByText("Owner")).toBeTruthy();
  expect(updateProjectSharing).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
  await waitFor(() => expect(updateProjectSharing).toHaveBeenCalledWith("p1", {
    visibility: "organization",
    organizationRole: "editor",
    confirmAudience: true
  }));
});

it("discards an unsaved organization role when switching back to private", async () => {
  renderSharing();
  const visibility = await screen.findByLabelText("Who can access");
  fireEvent.change(visibility, { target: { value: "organization" } });
  fireEvent.change(screen.getByLabelText("Organization access"), { target: { value: "editor" } });
  fireEvent.change(visibility, { target: { value: "private" } });

  expect((screen.getByRole("button", { name: "Save access" }) as HTMLButtonElement).disabled).toBe(true);
  expect(updateProjectSharing).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Share this project with your organization?" })).toBeNull();
});

it("describes an organization permission change instead of a new disclosure", async () => {
  vi.mocked(getProjectAccess).mockResolvedValue({
    visibility: "organization",
    organizationRole: "viewer",
    members: [{ userId: "u1", role: "owner", displayName: "Owner", email: "owner@example.com" }]
  });
  renderSharing();
  await screen.findByLabelText("Who can access");
  fireEvent.change(screen.getByLabelText("Organization access"), { target: { value: "editor" } });
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));

  expect(screen.getByRole("heading", { name: "Change organization access to edit?" })).toBeTruthy();
  expect(screen.getByText(/already has access/)).toBeTruthy();
  expect(screen.queryByText(/existing conversations, attachments, files, and drafts will be included/)).toBeNull();
});

it("keeps the saved organization role when making a project private", async () => {
  vi.mocked(getProjectAccess).mockResolvedValue({
    visibility: "organization",
    organizationRole: "editor",
    members: [{ userId: "u1", role: "owner", displayName: "Owner", email: "owner@example.com" }]
  });
  renderSharing();
  fireEvent.change(await screen.findByLabelText("Who can access"), { target: { value: "private" } });
  expect(screen.getByText(/last organization permission, edit, will be kept/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));

  await waitFor(() => expect(updateProjectSharing).toHaveBeenCalledWith("p1", {
    visibility: "private",
    organizationRole: "editor",
    confirmAudience: false
  }));
});

it("shows a changed-elsewhere notice when a concurrent change makes the audience stale", async () => {
  vi.mocked(updateProjectSharing).mockRejectedValueOnce(new ApiError({
    status: 409,
    code: "project_audience_confirmation_required",
    method: "PUT",
    path: "/projects/p1/sharing",
    message: "Confirm the current project audience."
  }));
  vi.mocked(getProjectAccess)
    .mockResolvedValueOnce({
      visibility: "private",
      organizationRole: "viewer",
      members: [{ userId: "u1", role: "owner", displayName: "Owner", email: "owner@example.com" }]
    })
    .mockResolvedValueOnce({
      visibility: "organization",
      organizationRole: "editor",
      members: [{ userId: "u1", role: "owner", displayName: "Owner", email: "owner@example.com" }]
    });
  renderSharing();
  const visibility = await screen.findByLabelText("Who can access");
  fireEvent.change(visibility, { target: { value: "organization" } });
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

  await screen.findByText(/Project access changed in another tab/);
  expect(screen.queryByRole("heading", { name: "Share this project with your organization?" })).toBeNull();
  expect(screen.getByText(/shared with the organization as edit/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Use saved access" })).toBeTruthy();
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
});
