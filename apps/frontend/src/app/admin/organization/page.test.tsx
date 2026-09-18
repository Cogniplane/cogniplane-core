// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import * as api from "../../../lib/admin-api";
import { queryKeys } from "../../../lib/query-keys";
import { useTenantSettings } from "../../../hooks/use-tenant-settings";
import { makeTenantSettings } from "../../../test-helpers/tenant-settings";
import Page from "./page";

type ModelCardProps = ComponentProps<typeof import("../../../components/admin/admin-model-availability-card").AdminModelAvailabilityCard>;
type OrganizationCardProps = ComponentProps<typeof import("../../../components/admin/admin-organization-card").AdminOrganizationCard>;

vi.mock("../../../lib/auth-context", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("../../../lib/admin-api", () => ({
  getTenantDetails: async () => null,
  getAdminModelCatalog: async () => ({ models: [], providers: [] }),
  getOpenRouterModels: async () => [],
  getTenantSettings: vi.fn(),
  updateTenantModelAvailability: vi.fn(),
  updateTenantAgentSettings: vi.fn(),
  updateTenantProviderKey: vi.fn(),
  createCustomModel: vi.fn(),
  deleteCustomModel: vi.fn()
}));
// Test page mutation wiring with real queries; existing card tests cover the forms.
vi.mock("../../../components/admin/admin-organization-card", () => ({
  AdminOrganizationCard: ({ onSaveProviderKey, providerSuccessMessage }: OrganizationCardProps) => <>
    <button onClick={() => void onSaveProviderKey("openai", "test-key")}>Save key</button>
    <button onClick={() => void onSaveProviderKey("openai", "")}>Remove key</button>
    <p>{providerSuccessMessage.openai}</p>
  </>
}));
vi.mock("../../../components/admin/admin-model-availability-card", () => ({
  AdminModelAvailabilityCard: ({ onSave, onAddModel, onRemoveModel, addError }: ModelCardProps) => <>
    <button onClick={() => void onSave({ enabledProviders: ["openai"], enabledModelIds: [], modelDefaultEfforts: {} })}>Save availability</button>
    <button onClick={() => void onAddModel({ provider: "openai", vendorModelId: "test-model", displayName: "Test model", contextWindow: 1000 })}>Add model</button>
    <button onClick={() => void onRemoveModel("openai/test-model")}>Remove model</button>
    {addError ? <p>{addError}</p> : null}
  </>
}));

const settings = makeTenantSettings();
const actions = [
  ["Save key", "updateTenantProviderKey"],
  ["Remove key", "updateTenantProviderKey"],
  ["Save availability", "updateTenantModelAvailability"],
  ["Add model", "createCustomModel"],
  ["Remove model", "deleteCustomModel"]
] as const;

const fetchChoices = vi.fn(async () => "Updated model choices");
function ChatChoices() {
  const query = useQuery({ queryKey: queryKeys.models.list(), queryFn: fetchChoices });
  return <p>{query.data}</p>;
}
function RuntimeStatus() {
  const query = useQuery({ queryKey: queryKeys.admin.runtimeSessions(), queryFn: async () => "Terminated" });
  return <p>{query.data}</p>;
}
function AgentSettingsSave() {
  const { save } = useTenantSettings();
  return <button onClick={() => void save({ ...settings, showEffortSelector: true })}>Save agent settings</button>;
}
const clients: QueryClient[] = [];
function renderPage({ showChat = true, initialSettings = settings } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(queryKeys.models.list(), "Cached model choices");
  client.setQueryData(queryKeys.admin.tenantSettings(), initialSettings);
  render(<QueryClientProvider client={client}><Page /><AgentSettingsSave />{showChat ? <ChatChoices /> : null}</QueryClientProvider>);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTenantSettings).mockResolvedValue(settings);
  vi.mocked(api.updateTenantModelAvailability).mockResolvedValue({ ...settings, enabledModelIds: [] });
  vi.mocked(api.updateTenantAgentSettings).mockResolvedValue({ ...settings, showEffortSelector: true });
  vi.mocked(api.updateTenantProviderKey).mockResolvedValue({ ok: true, providerKeys: { anthropic: false, openai: true, google: false, openrouter: false, zai: false } });
  vi.mocked(api.createCustomModel).mockResolvedValue({ id: "openai/test-model", displayName: "Test model", description: "", provider: "openai", isDefault: false, supportedEfforts: [], defaultEffort: null, contextWindow: 1000 });
  vi.mocked(api.deleteCustomModel).mockResolvedValue(settings);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe("Model data after admin changes", () => {
  it.each(actions)("refreshes cached chat choices after %s", async (label, method) => {
    renderPage();
    expect(screen.getByText("Cached model choices")).toBeTruthy();
    expect(fetchChoices).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(await screen.findByText("Updated model choices")).toBeTruthy();
    expect(api[method]).toHaveBeenCalledOnce();
  });

  it.each(actions)("keeps cached choices when %s fails", async (label, method) => {
    vi.mocked(api[method]).mockRejectedValueOnce(new Error("Save rejected"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(await screen.findByText("Save rejected")).toBeTruthy();
    expect(screen.getByText("Cached model choices")).toBeTruthy();
    expect(fetchChoices).not.toHaveBeenCalled();
  });

  it("reloads the model list when returning to chat before cache expiry", async () => {
    const client = renderPage({ showChat: false });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText("OpenAI API key saved.");
    render(<QueryClientProvider client={client}><ChatChoices /></QueryClientProvider>);
    expect(await screen.findByText("Updated model choices")).toBeTruthy();
  });

  it("refreshes settings after deletion removes model references", async () => {
    const initialSettings = makeTenantSettings({
      enabledModelIds: ["openai/test-model"],
      modelDefaultEfforts: { "openai/test-model": "high" }
    });
    const canonical = makeTenantSettings({ enabledModelIds: null, modelDefaultEfforts: {} });
    vi.mocked(api.deleteCustomModel).mockResolvedValueOnce(canonical);
    const client = renderPage({ initialSettings });
    fireEvent.click(screen.getByRole("button", { name: "Remove model" }));
    await screen.findByText("Updated model choices");
    await waitFor(() => expect(client.getQueryData(queryKeys.admin.tenantSettings())).toEqual(canonical));
    expect(api.getTenantSettings).not.toHaveBeenCalled();
  });

  it.each(["Save availability", "Save agent settings"])("refreshes runtime sessions after %s", async (label) => {
    const client = renderPage();
    client.setQueryData(queryKeys.admin.runtimeSessions(), "Running");
    fireEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText("Updated model choices");
    render(<QueryClientProvider client={client}><RuntimeStatus /></QueryClientProvider>);
    expect(await screen.findByText("Terminated")).toBeTruthy();
  });

  it("refreshes chat metadata after changing the effort-selector setting", async () => {
    const client = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Save agent settings" }));
    expect(await screen.findByText("Updated model choices")).toBeTruthy();
    await waitFor(() => expect(client.getQueryData(queryKeys.admin.tenantSettings())).toEqual({ ...settings, showEffortSelector: true }));
  });
});
