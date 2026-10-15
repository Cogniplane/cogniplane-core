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
    { id: "stale", name: "Stale", description: "Needs new token", connectionStatus: "reconnect_required" }
  ] });
  render(<PersonalCapabilitiesForm expectedScope={scope} />);
  expect(await screen.findByText(/Your credentials are saved/)).toBeTruthy();
  expect(screen.getByText(/Account label: Work/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/settings/connections");
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
