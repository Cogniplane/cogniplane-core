// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import * as api from "../../../lib/admin-api";
import { ApiError } from "../../../lib/api-client";
import { queryKeys } from "../../../lib/query-keys";
import { useTenantSettings } from "../../../hooks/use-tenant-settings";
import { makeTenantSettings } from "../../../test-helpers/tenant-settings";
import Page from "./page";

let providerQuery = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(providerQuery) }));

const cardResults = vi.hoisted(() => ({ save: [] as unknown[] }));
type ModelCardProps = ComponentProps<typeof import("../../../components/admin/admin-model-availability-card").AdminModelAvailabilityCard>;

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
vi.mock("../../../components/admin/admin-model-availability-card", () => ({
  AdminModelAvailabilityCard: ({ onSave, onAddModel, onRemoveModel, addError, saveError, providerKeys }: ModelCardProps) => <>
    {saveError ? <p>{saveError}</p> : null}
    <p>Target provider: {providerKeys.targetProvider ?? "none"}</p>
    <button onClick={() => void providerKeys.onSaveProviderKey("openai", "test-key")}>Save key</button>
    <button onClick={() => void providerKeys.onSaveProviderKey("openai", "")}>Remove key</button>
    <p>{providerKeys.providerSuccessMessage.openai}</p>
    <p>{providerKeys.providerErrorMessage.openai}</p>
    <button onClick={() => void onSave({ expectedVersion: 1, enabledProviders: ["openai"], enabledModelIds: [], defaultModelId: null, modelDefaultEfforts: {}, showEffortSelector: false }).then((result) => { cardResults.save.push(result); })}>Save availability</button>
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
  return <button onClick={() => void save({ ...settings, expectedVersion: settings.version, showEffortSelector: true })}>Save agent settings</button>;
}
const clients: QueryClient[] = [];
let rerenderPage: ReturnType<typeof render>["rerender"];
function renderPage({ showChat = true, initialSettings = settings } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(queryKeys.models.list(), "Cached model choices");
  client.setQueryData(queryKeys.models.adminCatalog(), { models: [], providers: [] });
  client.setQueryData(queryKeys.admin.tenantSettings(), initialSettings);
  rerenderPage = render(<QueryClientProvider client={client}><Page /><AgentSettingsSave />{showChat ? <ChatChoices /> : null}</QueryClientProvider>).rerender;
  return client;
}

beforeEach(() => {
  providerQuery = "";
  vi.clearAllMocks();
  cardResults.save = [];
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
  it("tracks provider links while the page stays mounted", async () => {
    providerQuery = "provider=google";
    const client = renderPage();
    expect(await screen.findByText("Target provider: google")).toBeTruthy();
    providerQuery = "provider=openai";
    rerenderPage(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
    expect(screen.getByText("Target provider: openai")).toBeTruthy();
    providerQuery = "provider=missing";
    rerenderPage(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
    expect(screen.getByRole("alert").textContent).toContain("not available");
    expect(screen.getByText("Target provider: none")).toBeTruthy();
    expect(api.updateTenantProviderKey).not.toHaveBeenCalled();
  });
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

  it("reloads settings after a save conflict and hands the newer version to the draft", async () => {
    const newer = makeTenantSettings({ version: 5, developerInstructions: "Saved on another page" });
    vi.mocked(api.updateTenantModelAvailability).mockRejectedValueOnce(new ApiError({
      status: 409, code: "settings_conflict", method: "PUT", path: "/admin/tenant-settings", message: "Settings changed."
    }));
    vi.mocked(api.getTenantSettings).mockResolvedValue(newer);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(cardResults.save).toEqual([{ conflict: newer }]));
    expect(api.getTenantSettings).toHaveBeenCalledOnce();
  });

  it("reports other failed saves as failed without a reload", async () => {
    vi.mocked(api.updateTenantModelAvailability).mockRejectedValueOnce(new Error("Save rejected"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(cardResults.save).toEqual([false]));
    expect(api.getTenantSettings).not.toHaveBeenCalled();
  });

  it("refreshes chat metadata after changing the effort-selector setting", async () => {
    const client = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Save agent settings" }));
    expect(await screen.findByText("Updated model choices")).toBeTruthy();
    await waitFor(() => expect(client.getQueryData(queryKeys.admin.tenantSettings())).toEqual({ ...settings, showEffortSelector: true }));
  });
});
