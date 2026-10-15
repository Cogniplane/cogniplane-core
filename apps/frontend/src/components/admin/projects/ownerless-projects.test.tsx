// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@cogniplane/shared-types";

import { ApiError } from "../../../lib/api-client";
import { listAdminUsers } from "../../../lib/admin-api";
import { listOwnerlessProjects, recoverProjectOwner } from "../../../lib/admin-projects-api";
import { useAuth } from "../../../lib/auth-context";
import { OwnerlessProjects } from "./ownerless-projects";

vi.mock("../../../lib/admin-api", () => ({ listAdminUsers: vi.fn() }));
vi.mock("../../../lib/admin-projects-api", () => ({ listOwnerlessProjects: vi.fn(), recoverProjectOwner: vi.fn() }));
vi.mock("../../../lib/auth-context", () => ({ useAuth: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function person(userId: string, overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    userId, tenantId: "tenant-a", email: `${userId}@example.test`, displayName: null, role: "member",
    isBetaTester: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
const PROJECTS = [{ projectId: "p1", name: "Q3 planning" }, { projectId: "p2", name: "Vendor review" }];
const apiError = (status: number, code: string, message = "From the server") =>
  new ApiError({ status, code, method: "GET", path: "/admin/projects/ownerless", message });

const clients: QueryClient[] = [];
function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><OwnerlessProjects /></QueryClientProvider>);
}
const row = (name: string) => screen.getByText(name).closest("li")!;
const chooser = (name: string) => screen.getByLabelText(`New owner for ${name}`) as HTMLSelectElement;
const assignButton = (name: string) => screen.getByRole("button", { name: `Assign owner for ${name}` }) as HTMLButtonElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { userId: "admin-1", role: "admin" } } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(listOwnerlessProjects).mockResolvedValue(PROJECTS);
  vi.mocked(listAdminUsers).mockResolvedValue([
    person("walter", { displayName: "Walter Skinner" }),
    person("dana", { displayName: "Dana Scully" }),
    person("admin-1", { displayName: "Fox Mulder", role: "admin" })
  ]);
  vi.mocked(recoverProjectOwner).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe("ownerless projects", () => {
  it("lists project names with a person to choose, and reads nothing else of a project", async () => {
    renderScreen();

    const list = await screen.findByRole("list", { name: "Projects without an owner" });
    expect(within(list).getAllByRole("listitem").map((item) => item.querySelector("span")?.textContent)).toEqual(["Q3 planning", "Vendor review"]);
    await waitFor(() => expect(chooser("Q3 planning").disabled).toBe(false));
    // People are sorted by name. The admin is marked.
    expect([...chooser("Q3 planning").options].map((option) => option.textContent)).toEqual([
      "Choose a person",
      "Dana Scully (dana@example.test)",
      "Fox Mulder (admin-1@example.test) (you)",
      "Walter Skinner (walter@example.test)"
    ]);
    expect(assignButton("Q3 planning").disabled).toBe(true);
    // No link opens a project from here.
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  it("asks for confirmation, then assigns the chosen person and loads the list again", async () => {
    vi.mocked(listOwnerlessProjects).mockResolvedValueOnce(PROJECTS).mockResolvedValue([PROJECTS[1]!]);
    renderScreen();
    await waitFor(() => expect(chooser("Q3 planning").disabled).toBe(false));

    fireEvent.change(chooser("Q3 planning"), { target: { value: "dana" } });
    fireEvent.click(assignButton("Q3 planning"));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Make Dana Scully the owner of Q3 planning?")).toBeTruthy();
    expect(dialog.textContent).toContain("open and manage everything in this project");
    expect(dialog.textContent).toContain("audit log");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(recoverProjectOwner).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Make owner" }));

    await waitFor(() => expect(recoverProjectOwner).toHaveBeenCalledWith("p1", "dana"));
    expect(recoverProjectOwner).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Q3 planning")).toBeNull());
    expect(screen.getByText("Vendor review")).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith("Dana Scully is now the owner of Q3 planning.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("changes nothing when the admin cancels", async () => {
    renderScreen();
    await waitFor(() => expect(chooser("Vendor review").disabled).toBe(false));
    fireEvent.change(chooser("Vendor review"), { target: { value: "walter" } });
    fireEvent.click(assignButton("Vendor review"));

    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(recoverProjectOwner).not.toHaveBeenCalled();
    expect(chooser("Vendor review").value).toBe("walter");
  });

  it("warns an admin who chooses themselves that they will get access to the project", async () => {
    renderScreen();
    await waitFor(() => expect(chooser("Q3 planning").disabled).toBe(false));

    fireEvent.change(chooser("Q3 planning"), { target: { value: "admin-1" } });
    fireEvent.click(assignButton("Q3 planning"));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("alert").textContent).toContain("You chose yourself. You will get access to everything in this project.");
  });

  it("keeps each choice with its own project", async () => {
    renderScreen();
    await waitFor(() => expect(chooser("Q3 planning").disabled).toBe(false));

    fireEvent.change(chooser("Q3 planning"), { target: { value: "dana" } });

    expect(chooser("Vendor review").value).toBe("");
    expect(assignButton("Vendor review").disabled).toBe(true);
    expect(assignButton("Q3 planning").disabled).toBe(false);
    expect(within(row("Q3 planning")).getByRole("button").textContent).toBe("Assign owner");
  });

  it("explains a project that got an owner meanwhile, and shows the list as it is now", async () => {
    vi.mocked(listOwnerlessProjects).mockResolvedValueOnce(PROJECTS).mockResolvedValue([PROJECTS[1]!]);
    vi.mocked(recoverProjectOwner).mockRejectedValue(apiError(409, "project_has_owner"));
    renderScreen();
    await waitFor(() => expect(chooser("Q3 planning").disabled).toBe(false));
    fireEvent.change(chooser("Q3 planning"), { target: { value: "dana" } });
    fireEvent.click(assignButton("Q3 planning"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make owner" }));

    expect((await screen.findByRole("alert")).textContent).toContain("This project already has an owner.");
    await waitFor(() => expect(screen.queryByText("Q3 planning")).toBeNull());
    expect(screen.getByText("Vendor review")).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("explains a person who left the organization, and loads people again", async () => {
    vi.mocked(recoverProjectOwner).mockRejectedValue(apiError(404, "organization_member_not_found"));
    renderScreen();
    await waitFor(() => expect(chooser("Q3 planning").disabled).toBe(false));
    fireEvent.change(chooser("Q3 planning"), { target: { value: "dana" } });
    fireEvent.click(assignButton("Q3 planning"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make owner" }));

    expect((await screen.findByRole("alert")).textContent).toContain("no longer a member of the organization");
    await waitFor(() => expect(listAdminUsers).toHaveBeenCalledTimes(2));
    // The project is still listed, with its choice cleared.
    expect(chooser("Q3 planning").value).toBe("");
  });

  it("shows that every project has an owner, and does not load people", async () => {
    vi.mocked(listOwnerlessProjects).mockResolvedValue([]);
    renderScreen();

    expect((await screen.findByText("Every project has an owner.")).getAttribute("role")).toBe("status");
    expect(screen.queryByRole("list", { name: "Projects without an owner" })).toBeNull();
    expect(listAdminUsers).not.toHaveBeenCalled();
  });

  it("shows no project names to a person the backend refuses, and does not load people", async () => {
    vi.mocked(listOwnerlessProjects).mockRejectedValue(apiError(403, "organization_admin_required"));
    renderScreen();

    expect((await screen.findByText("Only organization admins can see and recover projects without an owner.")).textContent).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Projects without an owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Assign owner/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(listAdminUsers).not.toHaveBeenCalled();
  });

  it("offers Retry after another load error", async () => {
    vi.mocked(listOwnerlessProjects).mockRejectedValueOnce(apiError(500, "internal_error", "Request failed: 500"));
    renderScreen();

    expect((await screen.findByRole("alert")).textContent).toContain("Could not load projects. Request failed: 500");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Q3 planning")).toBeTruthy();
  });
});
