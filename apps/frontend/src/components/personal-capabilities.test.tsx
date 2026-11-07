// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { getPersonalCapabilities, updatePersonalCapabilities } from "@/lib/personal-capabilities-api";
import { PersonalCapabilitiesForm } from "./personal-capabilities";

vi.mock("@/lib/personal-capabilities-api", () => ({ getPersonalCapabilities: vi.fn(), updatePersonalCapabilities: vi.fn() }));
const scope = { tenantId: "tenant-a", userId: "person-a" };
const catalog = { selection: null, version: 2, canEdit: true, scope,
  skills: [{ id: "pdf", name: "PDF", description: "Read documents" }],
  connectors: [{ id: "docs", name: "Docs", description: "Company documents" }] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPersonalCapabilities).mockResolvedValue(catalog);
  vi.mocked(updatePersonalCapabilities).mockResolvedValue(catalog);
});
afterEach(cleanup);

it("loads inherited defaults and explains where they apply", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  expect(screen.getByLabelText("Loading personal capabilities")).toBeTruthy();
  expect(await screen.findByText("Using inherited defaults")).toBeTruthy();
  expect(screen.getByText(/standalone chats/)).toBeTruthy();
  expect(screen.getByText(/Projects and scheduled jobs use their own settings/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Connected accounts" }).getAttribute("href")).toBe("/settings/connections");
});

it("shows a personal connector's saved label and reconnect route", async () => {
  vi.mocked(getPersonalCapabilities).mockResolvedValue({ ...catalog, connectors: [
    { ...catalog.connectors[0], connectionStatus: "connected", accountLabel: "Work" },
    { id: "stale", name: "Stale", description: "Needs new token", connectionStatus: "reconnect_required" },
    { id: "held", name: "Held", description: "Saved before a password change", connectionStatus: "reconnect_required",
      connectionSuspended: true }
  ] });
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  expect(await screen.findByText(/Your credentials are saved/)).toBeTruthy();
  expect(screen.getByText(/Account label: Work/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/settings/connections");
  expect(screen.getAllByText(/Your account needs a new credential/)).toHaveLength(1);
  // A credential that a security change suspended links to its review.
  expect(screen.getByText(/Suspended because your account security changed/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/settings/connections");
});

it("retries a failed load", async () => {
  vi.mocked(getPersonalCapabilities).mockRejectedValueOnce(new Error("Offline"));
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "OfflineReload defaults");
  fireEvent.click(screen.getByRole("button", { name: "Reload defaults" }));
  expect(await screen.findByText("Using inherited defaults")).toBeTruthy();
  expect(getPersonalCapabilities).toHaveBeenCalledTimes(2);
});

it("blocks editing when the loaded defaults belong to another account", async () => {
  vi.mocked(getPersonalCapabilities).mockResolvedValueOnce({
    ...catalog, scope: { tenantId: "tenant-b", userId: "person-a" }
  });
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent",
    "Your account or organization changed. Reload this page before editing these defaults.Reload page");
  expect(screen.queryByRole("button", { name: "Customize" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reload defaults" })).toBeNull();
});

it("saves a custom empty selection and can reset to inherited defaults", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Docs from your defaults" }));
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.getByText("No connections selected.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updatePersonalCapabilities).toHaveBeenCalledWith({
    version: 2, scope, selection: { skillIds: [], connectorIds: [] }
  }));

  vi.mocked(getPersonalCapabilities).mockResolvedValue({ ...catalog, selection: { skillIds: [], connectorIds: [] } });
  cleanup();
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Reset to inherited defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updatePersonalCapabilities).toHaveBeenLastCalledWith({ version: 2, scope, selection: null }));
});

it("searches the approved catalog and keeps unavailable saved references", async () => {
  vi.mocked(getPersonalCapabilities).mockResolvedValue({
    ...catalog, selection: { skillIds: ["old-skill"], connectorIds: [] }
  });
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  expect(await screen.findByText("Unavailable resource")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Add skills or connections" }), { target: { value: "pdf" } });
  fireEvent.click(screen.getByRole("button", { name: "Add PDF to your defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updatePersonalCapabilities).toHaveBeenCalledWith({
    version: 2, scope, selection: { skillIds: ["old-skill", "pdf"], connectorIds: [] }
  }));
});

it("keeps an unsaved draft after a failure and can cancel it", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "OfflineReload defaults");
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Using inherited defaults")).toBeTruthy();
});

it("reloads a conflict version while keeping the draft for review", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new ApiError({
    status: 409, code: "capabilities_conflict", method: "PUT", path: "/me/capabilities", message: "Changed"
  }));
  // Another save released OCR into the inherited defaults.
  vi.mocked(getPersonalCapabilities).mockResolvedValue({ ...catalog, version: 3,
    skills: [...catalog.skills, { id: "ocr", name: "OCR", description: "Read scans" }] });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const notice = await screen.findByText(/settings changed while you were editing/);
  expect(notice.parentElement?.textContent).toContain("Added elsewhere: OCR");
  expect(notice.parentElement?.textContent).toContain("Your save removes: PDF, OCR");
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updatePersonalCapabilities).toHaveBeenLastCalledWith({
    version: 3, scope, selection: { skillIds: [], connectorIds: ["docs"] }
  }));
});

it("blocks a save that restores a connection another save removed", async () => {
  const withWiki = { ...catalog, connectors: [...catalog.connectors, { id: "wiki", name: "Wiki", description: "Team wiki" }] };
  vi.mocked(getPersonalCapabilities).mockResolvedValue({ ...withWiki, selection: { skillIds: [], connectorIds: ["docs", "wiki"] } });
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add PDF to your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new ApiError({
    status: 409, code: "capabilities_conflict", method: "PUT", path: "/me/capabilities", message: "Changed"
  }));
  // Another tab removed Wiki from the defaults.
  vi.mocked(getPersonalCapabilities).mockResolvedValue({ ...withWiki, version: 3, selection: { skillIds: [], connectorIds: ["docs"] } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const notice = await screen.findByText(/settings changed while you were editing/);
  expect(notice.parentElement?.textContent).toContain("Removed elsewhere, your save restores: Wiki");
  expect(notice.parentElement?.textContent).not.toContain("Added elsewhere");
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updatePersonalCapabilities).toHaveBeenLastCalledWith({
    version: 3, scope, selection: { skillIds: ["pdf"], connectorIds: ["docs", "wiki"] }
  }));
});

it("clears the retry notice when a conflict reload matches the draft", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new ApiError({
    status: 409, code: "capabilities_conflict", method: "PUT", path: "/me/capabilities", message: "Changed"
  }));
  vi.mocked(getPersonalCapabilities).mockResolvedValue({
    ...catalog, version: 3, selection: { skillIds: [], connectorIds: ["docs"] }
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(getPersonalCapabilities).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(screen.queryByText(/save again/)).toBeNull();
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove Docs from your defaults" })).toBeTruthy();
});

it("blocks a scope conflict without reloading or resubmitting the draft", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new ApiError({
    status: 409, code: "capabilities_scope_changed", method: "PUT", path: "/me/capabilities", message: "Account changed"
  }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("button", { name: "Reload page" })).toBeTruthy();
  expect(getPersonalCapabilities).toHaveBeenCalledTimes(1);
  expect(updatePersonalCapabilities).toHaveBeenCalledWith({
    scope, version: 2, selection: { skillIds: [], connectorIds: ["docs"] }
  });
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(screen.queryByText("No skills selected.")).toBeNull();
});

it("blocks editing if a manual reload returns another account", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  vi.mocked(getPersonalCapabilities).mockResolvedValueOnce({
    ...catalog, scope: { tenantId: "tenant-a", userId: "person-b" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Reload defaults" }));
  expect(await screen.findByRole("button", { name: "Reload page" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(screen.queryByText("No skills selected.")).toBeNull();
});

it("keeps the draft read-only after access is denied", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new ApiError({
    status: 403, code: "membership_required", method: "PUT", path: "/me/capabilities", message: "Access denied"
  }));
  vi.mocked(getPersonalCapabilities).mockResolvedValueOnce({ ...catalog, canEdit: false });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(getPersonalCapabilities).toHaveBeenCalledTimes(2));
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});

it("disables Customize while a reset save is pending", async () => {
  vi.mocked(getPersonalCapabilities).mockResolvedValue({
    ...catalog, selection: { skillIds: ["pdf"], connectorIds: ["docs"] }
  });
  let resolveSave!: (value: typeof catalog) => void;
  vi.mocked(updatePersonalCapabilities).mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Reset to inherited defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updatePersonalCapabilities).toHaveBeenCalledTimes(1));
  const customize = screen.getByRole("button", { name: "Customize" }) as HTMLButtonElement;
  expect(customize.disabled).toBe(true);
  fireEvent.click(customize);
  expect(screen.getByText("Using inherited defaults")).toBeTruthy();
  resolveSave(catalog);
  await waitFor(() => expect(customize.disabled).toBe(false));
});

it("disables edit controls while capabilities reload", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  let resolveLoad!: (value: typeof catalog) => void;
  vi.mocked(getPersonalCapabilities).mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Reload defaults" }));
  await waitFor(() => expect(getPersonalCapabilities).toHaveBeenCalledTimes(2));
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  resolveLoad(catalog);
  await waitFor(() => expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false));
});


it("moves focus from Customize to search, and from each disappearing selection control to its survivor", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  const customize = await screen.findByRole("button", { name: "Customize" });
  customize.focus(); fireEvent.click(customize);
  expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Add skills or connections" }));
  const remove = screen.getByRole("button", { name: "Remove PDF from your defaults" });
  remove.focus(); fireEvent.click(remove);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add PDF to your defaults" }));
  const add = screen.getByRole("button", { name: "Add PDF to your defaults" });
  add.focus(); fireEvent.click(add);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
});

it("blocks Save after a failed latest read and retains the draft until an explicit retry", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  vi.mocked(getPersonalCapabilities).mockRejectedValueOnce(new Error("Latest read failed"));
  fireEvent.click(screen.getByRole("button", { name: "Reload defaults" }));
  await screen.findByText("Latest read failed");
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(updatePersonalCapabilities).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload defaults" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText("No skills selected.")).toBeTruthy();
});


it("returns focus after Cancel and keeps reset unsaved until Save", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus(); fireEvent.click(cancel);
  expect(document.activeElement).toBe(screen.getByText("Using inherited defaults"));
  expect(updatePersonalCapabilities).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  const reset = screen.getByRole("button", { name: "Reset to inherited defaults" });
  reset.focus(); fireEvent.click(reset);
  expect(document.activeElement).toBe(screen.getByText("Using inherited defaults"));
  expect(updatePersonalCapabilities).not.toHaveBeenCalled();
});

it("announces saved defaults and focuses the saved feedback when Save disappears", async () => {
  const dirtyChange = vi.fn();
  vi.mocked(updatePersonalCapabilities).mockResolvedValueOnce({ ...catalog, version: 3, selection: { skillIds: [], connectorIds: ["docs"] } });
  render(<PersonalCapabilitiesForm expectedScope={scope} onDirtyChange={dirtyChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  const save = screen.getByRole("button", { name: "Save changes" });
  save.focus(); fireEvent.click(save);
  const feedback = await screen.findByText("Your chat defaults are saved.");
  expect(document.activeElement).toBe(feedback);
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  await waitFor(() => expect(dirtyChange).toHaveBeenLastCalledWith(false));
});

it("does not steal focus from another control when a delayed Save completes", async () => {
  let finish!: (value: typeof catalog) => void;
  vi.mocked(updatePersonalCapabilities).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  const save = screen.getByRole("button", { name: "Save changes" });
  save.focus(); fireEvent.click(save);
  const connectedAccounts = screen.getByRole("link", { name: "Connected accounts" });
  connectedAccounts.focus();
  finish(catalog);
  await screen.findByText("Your chat defaults are saved.");
  expect(document.activeElement).toBe(connectedAccounts);
  expect(updatePersonalCapabilities).toHaveBeenCalledTimes(1);
});

it("focuses a failed save and lets Retry recover without replacing the draft or taking another control's focus", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new Error("Offline"));
  const save = screen.getByRole("button", { name: "Save changes" });
  save.focus(); fireEvent.click(save);
  const alert = await screen.findByRole("alert");
  expect(document.activeElement).toBe(alert);
  let finish!: (value: typeof catalog) => void;
  vi.mocked(getPersonalCapabilities).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const retry = screen.getByRole("button", { name: "Reload defaults" });
  retry.focus(); fireEvent.click(retry);
  const connectedAccounts = screen.getByRole("link", { name: "Connected accounts" }); connectedAccounts.focus();
  finish(catalog);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(document.activeElement).toBe(connectedAccounts);
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  expect(updatePersonalCapabilities).toHaveBeenCalledTimes(1);
});

it("requires conflict comparison after recovery from a failed conflict read", async () => {
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  vi.mocked(updatePersonalCapabilities).mockRejectedValueOnce(new ApiError({ status: 409, code: "capabilities_conflict", method: "PUT", path: "/me/capabilities", message: "Changed" }));
  vi.mocked(getPersonalCapabilities).mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/their current values could not be loaded/);
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(getPersonalCapabilities).mockResolvedValueOnce({ ...catalog, version: 7, skills: [...catalog.skills, { id: "ocr", name: "OCR", description: "Scans" }] });
  const reload = screen.getByRole("button", { name: "Reload defaults" }); reload.focus(); fireEvent.click(reload);
  const keep = await screen.findByRole("button", { name: "Keep my changes" });
  expect(screen.getByText("Added elsewhere: OCR")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect(updatePersonalCapabilities).toHaveBeenCalledTimes(1);
  keep.focus(); fireEvent.click(keep);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updatePersonalCapabilities).toHaveBeenLastCalledWith({ scope, version: 7, selection: { skillIds: [], connectorIds: ["docs"] } }));
});

it("keeps selected unavailable references visible during search and moves Remove to search when there is no counterpart", async () => {
  vi.mocked(getPersonalCapabilities).mockResolvedValueOnce({ ...catalog, selection: { skillIds: ["old-a", "old-b"], connectorIds: [] } });
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  const search = await screen.findByRole("searchbox", { name: "Add skills or connections" });
  fireEvent.change(search, { target: { value: "no match" } });
  expect(screen.getAllByText("Unavailable resource")).toHaveLength(2);
  expect(screen.getByText(/Saved reference: old-a/)).toBeTruthy();
  expect(screen.getByText(/Saved reference: old-b/)).toBeTruthy();
  const remove = screen.getByRole("button", { name: "Remove Unavailable resource 1 from your defaults" });
  remove.focus(); fireEvent.click(remove);
  expect(document.activeElement).toBe(search);
  expect(screen.getByText(/Saved reference: old-b/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updatePersonalCapabilities).toHaveBeenCalledWith({ scope, version: 2, selection: { skillIds: ["old-b"], connectorIds: [] } }));
});


it("keeps the pending Save focused and sends only one write until it settles", async () => {
  let finish!: (value: typeof catalog) => void;
  vi.mocked(updatePersonalCapabilities).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  const save = screen.getByRole("button", { name: "Save changes" }); save.focus(); fireEvent.click(save);
  expect(save.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(save);
  fireEvent.click(save); fireEvent.click(save);
  expect(updatePersonalCapabilities).toHaveBeenCalledTimes(1);
  finish(catalog);
  await screen.findByText("Your chat defaults are saved.");
});
