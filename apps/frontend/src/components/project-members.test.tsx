// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api-client";
import { updateProjectMember } from "@/lib/project-api";
import { ProjectMembers } from "./project-members";
import type { ProjectAccess } from "./project-members.logic";

vi.mock("@/lib/project-api", () => ({ updateProjectMember: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const ANA = { userId: "ana", role: "owner", displayName: "Ana", email: "ana@example.test" } as const;
const BO = { userId: "bo", role: "editor", displayName: "Bo", email: "bo@example.test" } as const;
const CY = { userId: "cy", role: "owner", displayName: "Cy", email: "cy@example.test" } as const;

let client: QueryClient;
function renderMembers(options: {
  access?: Partial<ProjectAccess>; canManage?: boolean; currentUserId?: string;
} = {}) {
  const access: ProjectAccess = { visibility: "private", organizationRole: "viewer", members: [ANA, BO], ...options.access };
  return render(
    <QueryClientProvider client={client}>
      <ProjectMembers projectId="p1" access={access} canManage={options.canManage ?? true}
        currentUserId={options.currentUserId ?? "ana"} organizationNote={access.visibility === "organization"} />
    </QueryClientProvider>
  );
}
const dialog = () => screen.findByRole("alertdialog");
const NO_OWNER = "The project will have no owner. An organization admin can assign one later.";

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(updateProjectMember).mockResolvedValue({ role: null, effectiveRole: null });
});
afterEach(() => {
  cleanup();
  client.clear();
});

it("warns that the project will have no owner before the only owner leaves, and sends nothing until they confirm", async () => {
  renderMembers();

  fireEvent.click(screen.getByRole("button", { name: "Leave project" }));

  const open = await dialog();
  expect(within(open).getByRole("heading", { name: "Leave this project?" })).toBeTruthy();
  expect(within(open).getByRole("alert").textContent).toContain(NO_OWNER);
  expect(within(open).getByRole("alert").textContent).toContain("nobody can change owner-only settings");
  expect(updateProjectMember).not.toHaveBeenCalled();

  fireEvent.click(within(open).getByRole("button", { name: "Leave project" }));

  await waitFor(() => expect(updateProjectMember).toHaveBeenCalledWith("p1", "ana", { role: null, confirmRetainedRole: undefined }));
  expect(updateProjectMember).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Ana was removed from the project."));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("warns before the only owner is demoted, and sends the new role after the confirmation", async () => {
  renderMembers();

  fireEvent.change(screen.getByLabelText("Role of Ana"), { target: { value: "viewer" } });

  const open = await dialog();
  expect(within(open).getByRole("heading", { name: "Change your role to viewer?" })).toBeTruthy();
  expect(within(open).getByRole("alert").textContent).toContain(NO_OWNER);
  expect(updateProjectMember).not.toHaveBeenCalled();
  // The list still shows the saved role until the change is saved.
  expect((screen.getByLabelText("Role of Ana") as HTMLSelectElement).value).toBe("owner");

  fireEvent.click(within(open).getByRole("button", { name: "Change role" }));

  await waitFor(() => expect(updateProjectMember).toHaveBeenCalledWith("p1", "ana", { role: "viewer", confirmRetainedRole: undefined }));
});

it("changes nothing when the only owner cancels", async () => {
  renderMembers();
  fireEvent.click(screen.getByRole("button", { name: "Leave project" }));

  fireEvent.click(within(await dialog()).getByRole("button", { name: "Cancel" }));

  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(updateProjectMember).not.toHaveBeenCalled();
});

it("does not warn about a missing owner while another owner stays", async () => {
  renderMembers({ access: { members: [ANA, CY, BO] } });

  fireEvent.click(screen.getByRole("button", { name: "Leave project" }));

  const open = await dialog();
  expect(open.textContent).not.toContain(NO_OWNER);
  expect(within(open).queryByRole("alert")).toBeNull();
  expect(open.textContent).toContain("You will no longer be able to manage this project.");
});

it("does not warn when an editor is removed or an editor becomes an owner", async () => {
  renderMembers();

  fireEvent.click(screen.getByRole("button", { name: "Remove Bo" }));
  const remove = await dialog();
  expect(within(remove).getByRole("heading", { name: "Remove Bo from this project?" })).toBeTruthy();
  expect(within(remove).queryByRole("alert")).toBeNull();
  fireEvent.click(within(remove).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

  fireEvent.change(screen.getByLabelText("Role of Bo"), { target: { value: "owner" } });
  const promote = await dialog();
  expect(within(promote).queryByRole("alert")).toBeNull();
  fireEvent.click(within(promote).getByRole("button", { name: "Change role" }));
  await waitFor(() => expect(updateProjectMember).toHaveBeenCalledWith("p1", "bo", { role: "owner", confirmRetainedRole: undefined }));
});

it("names the access that organization sharing keeps, and confirms it with the change", async () => {
  renderMembers({ access: { visibility: "organization", organizationRole: "editor" } });

  fireEvent.click(screen.getByRole("button", { name: "Remove Bo" }));

  const open = await dialog();
  expect(open.textContent).toContain("Organization sharing still gives everyone in the organization edit access, including Bo.");
  fireEvent.click(within(open).getByRole("button", { name: "Remove member" }));
  await waitFor(() => expect(updateProjectMember).toHaveBeenCalledWith("p1", "bo", { role: null, confirmRetainedRole: "editor" }));
});

it("keeps the dialog open with the reason, and offers Try again, when the change fails", async () => {
  vi.mocked(updateProjectMember).mockRejectedValueOnce(new ApiError({
    status: 409, code: "project_organization_access_retained", method: "PUT", path: "/projects/p1/members/bo",
    message: "Confirm the retained access to continue."
  }));
  renderMembers();
  fireEvent.click(screen.getByRole("button", { name: "Remove Bo" }));
  fireEvent.click(within(await dialog()).getByRole("button", { name: "Remove member" }));

  const open = await dialog();
  await waitFor(() => expect(within(open).getByRole("alert").textContent).toBe("Confirm the retained access to continue."));
  expect(toast.success).not.toHaveBeenCalled();
  fireEvent.click(within(open).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(updateProjectMember).toHaveBeenCalledTimes(2));
});

it("loads the project data again after a saved change", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  renderMembers();
  fireEvent.click(screen.getByRole("button", { name: "Remove Bo" }));
  fireEvent.click(within(await dialog()).getByRole("button", { name: "Remove member" }));

  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["projects"] }));
});

it("shows roles as text and no controls to a person who cannot manage members", () => {
  renderMembers({ canManage: false });

  expect(screen.queryByLabelText("Role of Ana")).toBeNull();
  expect(screen.queryByRole("button", { name: /Leave|Remove/ })).toBeNull();
  expect(screen.getByText("owner")).toBeTruthy();
  expect(screen.getByText("editor")).toBeTruthy();
});

it("says Remove, not Leave, on every row when the page does not know the person", async () => {
  renderMembers({ currentUserId: "" });
  expect(screen.queryByRole("button", { name: "Leave project" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove Ana" })).toBeTruthy();
});

it("shows the empty state", () => {
  renderMembers({ access: { members: [] } });
  expect(screen.getByText("No explicit project members.")).toBeTruthy();
});
