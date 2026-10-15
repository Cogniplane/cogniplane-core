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

  expect((await within(dialog).findByRole("alert")).textContent).toBe("Failed to clear integration configuration.");

  fireEvent.click(within(dialog).getByRole("button", { name: "Clear configuration" }));
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
