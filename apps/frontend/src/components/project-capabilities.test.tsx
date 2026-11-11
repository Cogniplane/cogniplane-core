// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectCapabilities as Capabilities } from "@cogniplane/shared-types";
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
const custom = { ...catalog, selection: { skillIds: ["pdf"], connectorIds: ["docs"] } };
// A project skill release adds Notes to the saved custom selection.
const released = { ...custom, version: 3,
  skills: [...catalog.skills, { id: "project-skill", name: "Notes", description: "Project notes", source: "project" as const }],
  selection: { skillIds: ["pdf", "project-skill"], connectorIds: ["docs"] } };
const refresh = (view: ReturnType<typeof show>, refreshRevision: number) =>
  view.rerender(<ProjectCapabilities projectId="p1" archived={false} canManage refreshRevision={refreshRevision} />);
const review = () => screen.queryByText(/settings changed while you were editing/)?.parentElement?.textContent;
const saveButton = () => screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
function deferred() {
  let resolve!: (value: Capabilities) => void;
  const promise = new Promise<Capabilities>((done) => { resolve = done; });
  return { promise, resolve };
}

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

it("requires a review before a dirty draft replaces a selection that a skill release changed", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(custom);
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(getProjectCapabilities).mockResolvedValue(released);
  refresh(view, 1);
  expect(await screen.findByText("Notes")).toBeTruthy();
  fireEvent.click(saveButton());
  expect(updateProjectCapabilities).not.toHaveBeenCalled();
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(review()).toContain("Added elsewhere: Notes");
  expect(review()).toContain("Your save removes: PDF, Notes");
  expect(saveButton().disabled).toBe(true);
  // The review follows later edits.
  fireEvent.click(screen.getByRole("button", { name: "Add Notes to this project" }));
  expect(review()).toContain("Your save removes: PDF");
  expect(review()).not.toContain("PDF, Notes");
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  fireEvent.click(saveButton());
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenCalledWith("p1", {
    version: 3, selection: { skillIds: ["project-skill"], connectorIds: ["docs"] }
  }));
});

it("requires a review when a reload finds connections that another owner changed", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(custom);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(updateProjectCapabilities).mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(saveButton());
  await screen.findByRole("alert");
  // Another owner added the Wiki connection.
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...custom, version: 3,
    connectors: [...catalog.connectors, { id: "wiki", name: "Wiki", description: "Team wiki" }],
    selection: { skillIds: ["pdf"], connectorIds: ["docs", "wiki"] } });
  fireEvent.click(screen.getByRole("button", { name: "Reload capabilities" }));
  expect(await screen.findByText("Wiki")).toBeTruthy();
  fireEvent.click(saveButton());
  expect(updateProjectCapabilities).toHaveBeenCalledTimes(1);
  expect(review()).toContain("Added elsewhere: Wiki");
  expect(review()).toContain("Your save removes: PDF, Wiki");
});

it("keeps a valid draft without a review when a refresh changes only the version", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(custom);
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...custom, version: 3 });
  refresh(view, 1);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(saveButton().disabled).toBe(false));
  expect(review()).toBeUndefined();
  expect(screen.queryByText(/selection changed while you were editing/)).toBeNull();
  fireEvent.click(saveButton());
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenCalledWith("p1", {
    version: 3, selection: { skillIds: [], connectorIds: ["docs"] }
  }));
});

it("reviews later refreshes against the selection that the draft started from", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(custom);
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(getProjectCapabilities).mockResolvedValue(released);
  refresh(view, 1);
  await screen.findByText(/settings changed while you were editing/);
  // Another owner removes Docs before the next refresh.
  const withoutDocs = { ...released, version: 4, selection: { skillIds: ["pdf", "project-skill"], connectorIds: [] } };
  vi.mocked(getProjectCapabilities).mockResolvedValue(withoutDocs);
  refresh(view, 2);
  await waitFor(() => expect(review()).toContain("Removed elsewhere, your save restores: Docs"));
  expect(review()).toContain("Added elsewhere: Notes");
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  // After Keep, a refresh with no new change does not open the review again.
  refresh(view, 3);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(saveButton().disabled).toBe(false));
  expect(review()).toBeUndefined();
  // A newer change after Keep is compared with the kept version only.
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...withoutDocs, version: 5, selection: { skillIds: ["project-skill"], connectorIds: [] } });
  refresh(view, 4);
  await waitFor(() => expect(review()).toContain("Your save removes: Notes"));
  expect(review()).not.toContain("Added elsewhere");
  expect(review()).not.toContain("PDF");
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  fireEvent.click(saveButton());
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenCalledWith("p1", {
    version: 5, selection: { skillIds: [], connectorIds: ["docs"] }
  }));
  expect(updateProjectCapabilities).toHaveBeenCalledTimes(1);
});

it("keeps an edit made while a refresh is pending and reviews the newer selection", async () => {
  const first = deferred();
  const second = deferred();
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(custom)
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = show();
  await screen.findByText("Custom project selection");
  refresh(view, 1);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(2));
  refresh(view, 2);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(3));
  await act(async () => { first.resolve(custom); await first.promise; });
  const remove = screen.getByRole("button", { name: "Remove PDF from this project" }) as HTMLButtonElement;
  await waitFor(() => expect(remove.disabled).toBe(false));
  fireEvent.click(remove);
  await act(async () => { second.resolve(released); await second.promise; });
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(review()).toContain("Added elsewhere: Notes");
  expect(saveButton().disabled).toBe(true);
  // Cancel takes the newer saved selection and closes the review.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Remove Notes from this project" })).toBeTruthy();
  expect(review()).toBeUndefined();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});

it("ignores an older refresh that finishes after a newer one", async () => {
  const first = deferred();
  const second = deferred();
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(custom)
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = show();
  await screen.findByText("Custom project selection");
  refresh(view, 1);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(2));
  refresh(view, 2);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(3));
  await act(async () => { second.resolve(released); await second.promise; });
  expect(screen.getByRole("button", { name: "Remove Notes from this project" })).toBeTruthy();
  await act(async () => { first.resolve(custom); await first.promise; });
  expect(screen.getByRole("button", { name: "Remove Notes from this project" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});

it("ignores a refresh for the previous project after the project changes", async () => {
  const pending = deferred();
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(custom).mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ ...catalog, skills: [{ id: "sheets", name: "Sheets", description: "Spreadsheets" }] });
  const view = show();
  await screen.findByText("Custom project selection");
  refresh(view, 1);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(2));
  view.rerender(<ProjectCapabilities projectId="p2" archived={false} canManage refreshRevision={1} />);
  expect(await screen.findByText("Sheets")).toBeTruthy();
  await act(async () => { pending.resolve(released); await pending.promise; });
  expect(screen.queryByText("Notes")).toBeNull();
  expect(screen.getByText("Sheets")).toBeTruthy();
  expect(screen.getByText("Using organization defaults")).toBeTruthy();
});

it("keeps the review while the project is archived and after it is restored", async () => {
  vi.mocked(getProjectCapabilities).mockResolvedValueOnce(custom);
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Remove PDF from this project" }));
  vi.mocked(getProjectCapabilities).mockResolvedValue({ ...released, canEdit: false });
  view.rerender(<ProjectCapabilities projectId="p1" archived canManage />);
  await waitFor(() => expect(review()).toContain("Added elsewhere: Notes"));
  expect(screen.getByText("Restore this project to change its selection.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  vi.mocked(getProjectCapabilities).mockResolvedValue(released);
  view.rerender(<ProjectCapabilities projectId="p1" archived={false} canManage />);
  await waitFor(() => expect(getProjectCapabilities).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(review()).toContain("Added elsewhere: Notes"));
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  fireEvent.click(saveButton());
  await waitFor(() => expect(updateProjectCapabilities).toHaveBeenCalledWith("p1", {
    version: 3, selection: { skillIds: [], connectorIds: ["docs"] }
  }));
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
  expect(review()).toBeUndefined();
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
  expect(screen.getByText("Proposed: organization defaults")).toBeTruthy();
  expect(updateProjectCapabilities).toHaveBeenCalledWith("p1", { selection: null, version: 2 });
  resolveSave(catalog);
  await waitFor(() => expect(customize.disabled).toBe(false));
  expect(screen.getByText("Using organization defaults")).toBeTruthy();
});
