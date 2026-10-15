// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { ProjectCapabilities } from "./project-capabilities";
import { getProjectCapabilities, updateProjectCapabilities } from "@/lib/project-api";

vi.mock("@/lib/project-api", () => ({ getProjectCapabilities: vi.fn(), updateProjectCapabilities: vi.fn() }));
const catalog = { selection: null, version: 2, canEdit: true,
  skills: [{ id: "pdf", name: "PDF", description: "Read documents" }],
  connectors: [{ id: "docs", name: "Docs", description: "Company documents" }] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getProjectCapabilities).mockResolvedValue(catalog);
  vi.mocked(updateProjectCapabilities).mockResolvedValue(catalog);
});
afterEach(cleanup);
const show = (canManage = true) => render(<ProjectCapabilities projectId="p1" archived={false} canManage={canManage} />);

it("shows the owner's connection state without treating it as a project credential", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...catalog, connectors: [
    { ...catalog.connectors[0], connectionStatus: "not_connected" }
  ] });
  show();
  expect(await screen.findByText("Your account is not connected.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Connect" }).getAttribute("href")).toBe("/settings/connections");
  expect(screen.getByText(/Project selection does not share personal credentials/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  expect(screen.getByRole("button", { name: "Remove Docs from this project" })).toBeTruthy();
});

it("customizes a project from its organization library and resets to inherited defaults", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  expect(screen.getByText(/New organization resources stay out/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from this project" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenCalledWith("p1", {
    version: 2, selection: { skillIds: [], connectorIds: ["docs"] }
  }));
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...catalog, selection: { skillIds: [], connectorIds: ["docs"] } });
  cleanup();
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Reset to organization defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenLastCalledWith("p1", { version: 2, selection: null }));
});

it("keeps a custom empty selection and shows unavailable saved items", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...catalog, selection: { skillIds: ["removed"], connectorIds: [] } });
  show();
  expect(await screen.findByText("Unavailable resource")).toBeTruthy();
  expect(screen.getByText(/no longer in the available library/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove Unavailable resource 1 from this project" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenCalledWith("p1", {
    version: 2, selection: { skillIds: [], connectorIds: [] }
  }));
});

it("shows read-only settings to a member", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...catalog, canEdit: false, selection: { skillIds: ["pdf"], connectorIds: [] } });
  show(false);
  expect(await screen.findByText("Only project owners can change this selection.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Customize" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Remove PDF/ })).toBeNull();
});

it("shows inherited resources to a read-only member", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...catalog, canEdit: false });
  show(false);
  expect(await screen.findByText("Using organization defaults")).toBeTruthy();
  expect(screen.getByText("Read documents")).toBeTruthy();
  expect(screen.getByText("Company documents")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Customize" })).toBeNull();
});

it("lets an owner refresh availability after project work ends", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce({ ...catalog, canEdit: false });
  show();
  expect(await screen.findByText(/read-only while project work is active/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh availability" }));
  expect(await screen.findByRole("button", { name: "Customize" })).toBeTruthy();
});

it("preserves the draft after a save failure and reloads a conflict version", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(updateProjectCapabilities).mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "OfflineReload capabilities");
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  vi.mocked(getProjectCapabilities).mockResolvedValue(catalog);
  fireEvent.click(screen.getByRole("button", { name: "Reload capabilities" }));
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(2));
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  vi.mocked(updateProjectCapabilities).mockRejectedValueOnce(new ApiError({ status: 409, code: "capabilities_conflict", method: "PUT", path: "/projects/p1/capabilities", message: "Changed" }));
  // Another owner added the Wiki connection to a custom selection.
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...catalog, version: 3,
    connectors: [...catalog.connectors, { id: "wiki", name: "Wiki", description: "Team wiki" }],
    selection: { skillIds: ["pdf"], connectorIds: ["docs", "wiki"] } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const notice = await screen.findByText(/settings changed while you were editing/);
  expect(notice.parentElement?.textContent).toContain("Added elsewhere: Wiki");
  expect(notice.parentElement?.textContent).toContain("Your save removes: PDF, Wiki");
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenLastCalledWith("p1", {
    version: 3, selection: { skillIds: [], connectorIds: ["docs"] }
  }));
});

it("blocks a save that restores a connection another owner removed", async () => {
  const withWiki = { ...catalog, connectors: [...catalog.connectors, { id: "wiki", name: "Wiki", description: "Team wiki" }] };
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...withWiki, selection: { skillIds: [], connectorIds: ["docs", "wiki"] } });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Add PDF to this project" }));
  vi.mocked(updateProjectCapabilities).mockRejectedValueOnce(new ApiError({ status: 409, code: "capabilities_conflict", method: "PUT", path: "/projects/p1/capabilities", message: "Changed" }));
  // Another owner removed Wiki from the selection.
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...withWiki, version: 3, selection: { skillIds: [], connectorIds: ["docs"] } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const notice = await screen.findByText(/settings changed while you were editing/);
  expect(notice.parentElement?.textContent).toContain("Removed elsewhere, your save restores: Wiki");
  expect(notice.parentElement?.textContent).not.toContain("Added elsewhere");
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenLastCalledWith("p1", {
    version: 3, selection: { skillIds: ["pdf"], connectorIds: ["docs", "wiki"] }
  }));
});

it("refreshes available skills after a project skill release without dropping unsaved choices", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce({ ...catalog,
    selection: { skillIds: ["pdf"], connectorIds: ["docs"] } });
  const view = show();
  await screen.findByText("Custom project selection");
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...catalog, version: 3,
    selection: { skillIds: ["pdf", "project-skill"], connectorIds: ["docs"] },
    skills: [...catalog.skills, { id: "project-skill", name: "Notes", description: "Project notes", source: "project" as const }] });
  view.rerender(<ProjectCapabilities projectId="p1" archived={false} canManage refreshRevision={1} />);
  expect(await screen.findByText("Notes")).toBeTruthy();
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.getByText(/The current selection changed while you were editing/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
});

it("adopts a newly released skill when the custom selection has no unsaved edits", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce({ ...catalog,
    selection: { skillIds: ["pdf"], connectorIds: ["docs"] } });
  const view = show();
  await screen.findByText("Custom project selection");
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...catalog, version: 3,
    selection: { skillIds: ["pdf", "project-skill"], connectorIds: ["docs"] },
    skills: [...catalog.skills, { id: "project-skill", name: "Notes", description: "Project notes", source: "project" as const }] });
  view.rerender(<ProjectCapabilities projectId="p1" archived={false} canManage refreshRevision={1} />);
  expect(await screen.findByText("Notes")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove Notes from this project" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});

it("preserves a dirty draft when project ownership changes", async () => {
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce({ ...catalog, canEdit: false });
  view.rerender(<ProjectCapabilities projectId="p1" archived={false} canManage={false} />);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Only project owners can change this selection.")).toBeTruthy();
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

  view.rerender(<ProjectCapabilities projectId="p1" archived={false} canManage={true} />);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(3));
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenCalledWith("p1", {
    version: 2, selection: { skillIds: [], connectorIds: ["docs"] }
  }));
});

it("uses current archive status while keeping an unsaved draft", async () => {
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from this project" }));
  view.rerender(<ProjectCapabilities projectId="p1" archived canManage />);
  expect(screen.getByText("Restore this project to change its selection.")).toBeTruthy();
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  view.rerender(<ProjectCapabilities projectId="p1" archived={false} canManage />);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(3));
});

it("refreshes capability and project access after a forbidden save", async () => {
  const onAccessFailure = vi.fn(async () => {
    view.rerender(<ProjectCapabilities projectId="p1" archived={false} canManage={false}
      onAccessFailure={onAccessFailure} />);
  });
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(catalog)
    .mockResolvedValueOnce({ ...catalog, canEdit: false });
  const view = render(<ProjectCapabilities projectId="p1" archived={false} canManage onAccessFailure={onAccessFailure} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(updateProjectCapabilities).mockRejectedValueOnce(new ApiError({
    status: 403, code: "forbidden", method: "PUT", path: "/projects/p1/capabilities", message: "Forbidden"
  }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onAccessFailure).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(3));
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(screen.getByText("Only project owners can change this selection.")).toBeTruthy();
});

it("refreshes project status after a save finds it archived", async () => {
  const onAccessFailure = vi.fn(async () => {
    view.rerender(<ProjectCapabilities projectId="p1" archived canManage onAccessFailure={onAccessFailure} />);
  });
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(catalog)
    .mockResolvedValue({ ...catalog, canEdit: false });
  const view = render(<ProjectCapabilities projectId="p1" archived={false} canManage onAccessFailure={onAccessFailure} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(updateProjectCapabilities).mockRejectedValueOnce(new ApiError({
    status: 409, code: "project_archived", method: "PUT", path: "/projects/p1/capabilities", message: "Project archived"
  }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onAccessFailure).toHaveBeenCalledTimes(1));
  expect(screen.getByText("Restore this project to change its selection.")).toBeTruthy();
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});

it("keeps a neutral access notice when project detail cannot refresh", async () => {
  const onAccessFailure = vi.fn().mockRejectedValue(new Error("Offline"));
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(catalog)
    .mockResolvedValueOnce({ ...catalog, canEdit: false });
  render(<ProjectCapabilities projectId="p1" archived={false} canManage onAccessFailure={onAccessFailure} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(updateProjectCapabilities).mockRejectedValueOnce(new ApiError({
    status: 403, code: "forbidden", method: "PUT", path: "/projects/p1/capabilities", message: "Forbidden"
  }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Project access or availability changed. Refresh project settings.")).toBeTruthy();
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});

it("does not let Customize replace a draft during a pending save", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValue({
    ...catalog, selection: { skillIds: ["pdf"], connectorIds: ["docs"] }
  });
  let resolveSave!: (value: typeof catalog) => void;
  vi.mocked(updateProjectCapabilities).mockImplementationOnce(() => new Promise((resolve) => {
    resolveSave = resolve;
  }));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Reset to organization defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenCalledTimes(1));
  const customize = screen.getByRole("button", { name: "Customize" }) as HTMLButtonElement;
  expect(customize.disabled).toBe(true);
  fireEvent.click(customize);
  expect(screen.getByText("Using organization defaults")).toBeTruthy();
  resolveSave(catalog);
  await waitFor(() => expect(customize.disabled).toBe(false));
  expect(screen.getByText("Using organization defaults")).toBeTruthy();
});
