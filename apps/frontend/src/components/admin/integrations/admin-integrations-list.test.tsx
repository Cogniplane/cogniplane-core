// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminIntegrationView } from "@cogniplane/shared-types";

import { deleteIntegrationConfig, fetchAdminIntegrations, updateIntegration } from "../../../lib/integrations-api";
import { AdminIntegrationsList } from "./admin-integrations-list";

vi.mock("../../../lib/integrations-api", () => ({
  fetchAdminIntegrations: vi.fn(), updateIntegration: vi.fn(), deleteIntegrationConfig: vi.fn()
}));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

function integration(id: string, name: string, overrides: Partial<AdminIntegrationView> = {}): AdminIntegrationView {
  return {
    id, name, description: `${name} integration.`, longDescription: "", logoSlug: id, status: "available",
    category: "Tools", readToolIds: [`${id}_read`], writeToolIds: [], configMode: "none", readsEnabled: false,
    writesEnabled: false, hasConfig: false, configSummary: {}, updatedAt: null, updatedBy: null,
    platformConfigured: true, platformConfigMessage: null, ...overrides
  };
}

function oauthApp(id: string, name: string, overrides: Partial<AdminIntegrationView> = {}): AdminIntegrationView {
  return integration(id, name, {
    configMode: "oauth_app",
    configFields: [{ key: "clientId", label: "Client ID", type: "text", required: true }],
    ...overrides
  });
}

function renderList(integrations: AdminIntegrationView[]) {
  vi.mocked(fetchAdminIntegrations).mockResolvedValue(integrations);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><AdminIntegrationsList /></QueryClientProvider>);
  return client;
}

const reads = (name: string) => screen.getByRole("switch", { name: `Reads for ${name}` }) as HTMLInputElement;

it("lists available integrations by name and names the planned ones", async () => {
  renderList([
    integration("zendesk", "Zendesk"),
    integration("asana", "Asana"),
    integration("linear", "Linear", { status: "coming_soon" }),
    integration("jira", "Jira", { status: "coming_soon" })
  ]);

  await screen.findByRole("switch", { name: "Reads for Asana" });
  const names = screen.getAllByRole("switch").map((element) => element.getAttribute("aria-label"));
  expect(names).toEqual(["Reads for Asana", "Reads for Zendesk"]);
  expect(screen.getByText("Coming soon: Jira, Linear.")).toBeTruthy();
});

it("says when no integration is available yet", async () => {
  renderList([integration("linear", "Linear", { status: "coming_soon" })]);

  expect(await screen.findByText("No integrations available yet.")).toBeTruthy();
});

it("turns reads on for the flipped integration only, and locks it while saving", async () => {
  let respond!: () => void;
  vi.mocked(updateIntegration).mockReturnValue(new Promise((resolve) => {
    respond = () => resolve(integration("zendesk", "Zendesk", { readsEnabled: true }));
  }));
  renderList([integration("asana", "Asana"), integration("zendesk", "Zendesk")]);

  fireEvent.click(await screen.findByRole("switch", { name: "Reads for Zendesk" }));

  await waitFor(() => expect(reads("Zendesk").disabled).toBe(true));
  expect(updateIntegration).toHaveBeenCalledWith("zendesk", { readsEnabled: true });
  expect(reads("Asana").disabled).toBe(false);

  await act(async () => { respond(); });
  await waitFor(() => expect(reads("Zendesk").disabled).toBe(false));
  expect(reads("Zendesk").checked).toBe(true);
  expect(reads("Asana").checked).toBe(false);
});

it("shows a failed toggle, restores the switch, and leaves no unhandled rejection", async () => {
  vi.mocked(updateIntegration).mockRejectedValue(new Error("Rate limited."));
  renderList([integration("asana", "Asana")]);
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);

  try {
    fireEvent.click(await screen.findByRole("switch", { name: "Reads for Asana" }));
    expect(await screen.findByText("Rate limited.")).toBeTruthy();
    // Node reports an unhandled rejection after the microtasks drain.
    await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 10); }));
  } finally {
    process.off("unhandledRejection", unhandled);
  }

  expect(reads("Asana").checked).toBe(false);
  expect(unhandled).not.toHaveBeenCalled();
});

it("saves and then clears the OAuth app of the integration whose pane is open", async () => {
  const sharepoint = oauthApp("sharepoint", "SharePoint");
  vi.mocked(updateIntegration).mockResolvedValue({ ...sharepoint, hasConfig: true, configSummary: { clientId: "app-1" } });
  vi.mocked(deleteIntegrationConfig).mockResolvedValue(sharepoint);
  renderList([oauthApp("drive", "Google Drive"), sharepoint]);

  fireEvent.click(await screen.findByRole("button", { name: "Configure SharePoint" }));
  const dialog = await screen.findByRole("dialog", { name: "SharePoint" });
  fireEvent.change(within(dialog).getByLabelText(/Client ID/), { target: { value: "app-1" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));

  await within(dialog).findByRole("button", { name: "Update configuration" });
  expect(updateIntegration).toHaveBeenCalledWith("sharepoint", { config: { clientId: "app-1" } });

  fireEvent.click(within(dialog).getByRole("button", { name: "Clear configuration" }));
  const confirmation = await screen.findByRole("dialog", { name: "Clear SharePoint configuration?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Clear SharePoint configuration" }));
  await within(dialog).findByRole("button", { name: "Save configuration" });
  expect(deleteIntegrationConfig).toHaveBeenCalledWith("sharepoint");
});

it("shows a failed save inside the dialog, keeps the draft, and recovers on retry", async () => {
  const sharepoint = oauthApp("sharepoint", "SharePoint");
  vi.mocked(updateIntegration)
    .mockRejectedValueOnce(new Error("Client ID is not valid."))
    .mockResolvedValueOnce({ ...sharepoint, hasConfig: true, configSummary: { clientId: "app-2" } });
  renderList([sharepoint]);
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);

  try {
    fireEvent.click(await screen.findByRole("button", { name: "Configure SharePoint" }));
    const dialog = await screen.findByRole("dialog", { name: "SharePoint" });
    fireEvent.change(within(dialog).getByLabelText(/Client ID/), { target: { value: "app-2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("Client ID is not valid.");
    expect((within(dialog).getByLabelText(/Client ID/) as HTMLInputElement).value).toBe("app-2");
    // Node reports an unhandled rejection after the microtasks drain.
    await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 10); }));
    expect(unhandled).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));
    await within(dialog).findByRole("button", { name: "Update configuration" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(updateIntegration).toHaveBeenLastCalledWith("sharepoint", { config: { clientId: "app-2" } });
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

it("shows a failed clear inside the dialog and recovers on retry", async () => {
  const sharepoint = oauthApp("sharepoint", "SharePoint", { hasConfig: true, configSummary: { clientId: "app-1" } });
  vi.mocked(deleteIntegrationConfig)
    .mockRejectedValueOnce("")
    .mockResolvedValueOnce(oauthApp("sharepoint", "SharePoint"));
  renderList([sharepoint]);

  fireEvent.click(await screen.findByRole("button", { name: "Details for SharePoint" }));
  const dialog = await screen.findByRole("dialog", { name: "SharePoint" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Clear configuration" }));

  const confirmation = await screen.findByRole("dialog", { name: "Clear SharePoint configuration?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Clear SharePoint configuration" }));
  expect((await within(confirmation).findByRole("alert")).textContent).toBe("Failed to clear integration configuration.");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Clear SharePoint configuration" }));
  await within(dialog).findByRole("button", { name: "Save configuration" });
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

it("keeps another row's failed toggle out of the open dialog", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(updateIntegration).mockReturnValue(new Promise((_, r) => { reject = r; }));
  renderList([integration("asana", "Asana"), oauthApp("sharepoint", "SharePoint")]);

  fireEvent.click(await screen.findByRole("switch", { name: "Reads for Asana" }));
  fireEvent.click(screen.getByRole("button", { name: "Configure SharePoint" }));
  const dialog = await screen.findByRole("dialog", { name: "SharePoint" });
  await act(async () => { reject(new Error("Rate limited.")); });

  // The modal dialog hides the rows from the accessibility tree.
  await waitFor(() => expect((screen.getByRole("switch", { name: "Reads for Asana", hidden: true }) as HTMLInputElement).disabled).toBe(false));
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(within(dialog).queryByText("Rate limited.")).toBeNull();
});

it("closes the pane", async () => {
  renderList([oauthApp("sharepoint", "SharePoint")]);

  fireEvent.click(await screen.findByRole("button", { name: "Configure SharePoint" }));
  fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("separates loading, read failure, retry and a successful empty list without losing retry focus", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(fetchAdminIntegrations).mockResolvedValue([]).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><AdminIntegrationsList /></QueryClientProvider>);
  expect(screen.getByText("Loading integrations...")).toBeTruthy();
  expect(screen.queryByText("No integrations available yet.")).toBeNull();
  await act(async () => { fail(new Error("List unavailable")); });
  expect(await screen.findByText("Could not load integrations.")).toBeTruthy();
  expect(screen.queryByText("No integrations available yet.")).toBeNull();
  const retry = screen.getByRole("button", { name: "Retry integrations" });
  retry.focus();
  fireEvent.click(retry);
  expect(await screen.findByText("No integrations available yet.")).toBeTruthy();
  expect(document.activeElement).toBe(retry);
  expect(retry.textContent).toBe("Reload integrations");
});

it("keeps the last list during refresh and labels it stale after failure", async () => {
  renderList([integration("asana", "Asana")]);
  await screen.findByRole("switch", { name: "Reads for Asana" });
  let reject!: (error: Error) => void;
  vi.mocked(fetchAdminIntegrations).mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
  const reload = screen.getByRole("button", { name: "Reload integrations" });
  reload.focus();
  fireEvent.click(reload);
  expect(await screen.findByText("Refreshing integrations. Showing the last loaded list.")).toBeTruthy();
  expect(reads("Asana")).toBeTruthy();
  await act(async () => { reject(new Error("Refresh failed")); });
  expect(await screen.findByText("Could not refresh integrations. Showing the last loaded list.")).toBeTruthy();
  expect(reads("Asana")).toBeTruthy();
  expect(document.activeElement).toBe(reload);
});

it("retains the save dialog through Escape, blocks a duplicate submit, and keeps the failed draft", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(updateIntegration).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  renderList([oauthApp("sharepoint", "SharePoint")]);
  fireEvent.click(await screen.findByRole("button", { name: "Configure SharePoint" }));
  const dialog = screen.getByRole("dialog", { name: "SharePoint" });
  fireEvent.change(within(dialog).getByLabelText(/Client ID/), { target: { value: "fictional-draft" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));
  const pending = await within(dialog).findByRole("button", { name: "Saving configuration..." });
  fireEvent.click(pending);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "SharePoint" })).toBe(dialog);
  expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
  expect(updateIntegration).toHaveBeenCalledTimes(1);
  await act(async () => { fail(new Error("Try this save again")); });
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Try this save again");
  expect((within(dialog).getByLabelText(/Client ID/) as HTMLInputElement).value).toBe("fictional-draft");
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Save configuration" })));
});

it("cancels clear without a write, then protects a pending clear and returns focus after success", async () => {
  let finish!: (row: AdminIntegrationView) => void;
  vi.mocked(deleteIntegrationConfig).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const row = oauthApp("sharepoint", "SharePoint", { hasConfig: true, configSummary: { clientId: "fictional" } });
  renderList([row]);
  fireEvent.click(await screen.findByRole("button", { name: "Details for SharePoint" }));
  const dialog = screen.getByRole("dialog", { name: "SharePoint" });
  const clear = within(dialog).getByRole("button", { name: "Clear configuration" });
  fireEvent.click(clear);
  let confirmation = screen.getByRole("dialog", { name: "Clear SharePoint configuration?" });
  expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "Keep configuration" }));
  fireEvent.click(within(confirmation).getByRole("button", { name: "Keep configuration" }));
  await waitFor(() => expect(document.activeElement).toBe(clear));
  expect(deleteIntegrationConfig).not.toHaveBeenCalled();
  fireEvent.click(clear);
  confirmation = screen.getByRole("dialog", { name: "Clear SharePoint configuration?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Clear SharePoint configuration" }));
  await within(confirmation).findByRole("button", { name: "Clearing configuration..." });
  fireEvent.keyDown(confirmation, { key: "Escape" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Keep configuration" }));
  expect(screen.getByRole("dialog", { name: "Clear SharePoint configuration?" })).toBe(confirmation);
  expect(deleteIntegrationConfig).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ...row, hasConfig: false, configSummary: {}, readsEnabled: false, writesEnabled: false }); });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Clear SharePoint configuration?" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Save configuration" })));
});
