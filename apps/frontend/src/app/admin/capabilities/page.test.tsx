// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import type { AdminModelCatalogResponse, ModelProvider } from "@cogniplane/shared-types";

import { getAdminModelCatalog } from "../../../lib/admin-api";
import { useTenantSettings } from "../../../hooks/use-tenant-settings";
import { makeTenantSettings } from "../../../test-helpers/tenant-settings";
import { queryKeys } from "../../../lib/query-keys";
import Page from "./page";

vi.mock("../../../lib/auth-context", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("../../../hooks/use-tenant-settings", () => ({ useTenantSettings: vi.fn() }));
vi.mock("../../../lib/admin-api", () => ({
  getAdminModelCatalog: vi.fn(),
  listAdminManagedTools: async () => [],
  listAdminMcpServers: async () => []
}));

const settings = makeTenantSettings({ enabledProviders: [...MODEL_PROVIDERS] });

function catalog(selected: ModelProvider, keySource: "tenant" | "platform" | "none"): AdminModelCatalogResponse {
  return {
    models: MODEL_PROVIDERS.map((provider) => ({
      id: `${provider}/test-model`, displayName: `${MODEL_PROVIDER_META[provider].label} test model`,
      provider, description: "Test model", isDefault: provider === "anthropic", supportedEfforts: [],
      defaultEffort: null, contextWindow: 1000, source: "builtin"
    })),
    // Every unrelated provider has a key, which must never mask the selected provider's missing key.
    providers: MODEL_PROVIDERS.map((id) => ({
      id, label: MODEL_PROVIDER_META[id].label, keySource: id === selected ? keySource : "tenant"
    }))
  };
}

const clients: QueryClient[] = [];
function renderPage(initialCatalog?: AdminModelCatalogResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  if (initialCatalog) client.setQueryData(queryKeys.models.adminCatalog(), initialCatalog);
  return render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(useTenantSettings).mockReturnValue({
    settings, saving: false, error: null, save: async () => true, reload: async () => {}
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

async function loaded() {
  await waitFor(() => expect(screen.queryByText("Checking model availability...")).toBeNull());
  expect(screen.queryByText(/Could not check model availability/)).toBeNull();
}

describe("Agent settings model warning", () => {
  // A tenant key and the platform fallback are both usable, and the warning
  // does not branch on provider, so one provider covers both key-source paths.
  it.each(["tenant", "platform"] as const)("accepts a %s key source", async (keySource) => {
    localStorage.setItem("cogniplane:model", "openai/test-model");
    vi.mocked(getAdminModelCatalog).mockResolvedValue(catalog("openai", keySource));
    renderPage();
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No .* API key is configured/)).toBeNull();
  });

  it.each(MODEL_PROVIDERS)("warns for missing %s credentials despite unrelated keys", async (provider) => {
    localStorage.setItem("cogniplane:model", `${provider}/test-model`);
    vi.mocked(getAdminModelCatalog).mockResolvedValue(catalog(provider, "none"));
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain(`No ${MODEL_PROVIDER_META[provider].label} API key`);
  });

  it("uses the changed chat selection when the admin returns to settings", async () => {
    localStorage.setItem("cogniplane:model", "anthropic/test-model");
    vi.mocked(getAdminModelCatalog).mockResolvedValue(catalog("openai", "none"));
    const view = renderPage();
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No .* API key is configured/)).toBeNull();
    view.unmount();
    localStorage.setItem("cogniplane:model", "openai/test-model");
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain("No OpenAI API key");
  });

  it.each([
    { enabledProviders: ["anthropic"] as ModelProvider[] },
    { enabledModelIds: ["anthropic/test-model"] }
  ])("reports disabled selection separately from credentials: %j", async (availability) => {
    vi.mocked(useTenantSettings).mockReturnValue({
      settings: { ...settings, ...availability }, saving: false, error: null,
      save: async () => true, reload: async () => {}
    });
    localStorage.setItem("cogniplane:model", "openai/test-model");
    vi.mocked(getAdminModelCatalog).mockResolvedValue(catalog("openai", "platform"));
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain("disabled for this organization");
  });

  it("reports a removed model without guessing its credentials", async () => {
    localStorage.setItem("cogniplane:model", "removed/model");
    vi.mocked(getAdminModelCatalog).mockResolvedValue(catalog("openai", "none"));
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain("no longer available");
  });

  it("waits for the catalog before diagnosing missing credentials", async () => {
    let resolve!: (value: AdminModelCatalogResponse) => void;
    vi.mocked(getAdminModelCatalog).mockReturnValue(new Promise((done) => { resolve = done; }));
    localStorage.setItem("cogniplane:model", "openai/test-model");
    renderPage();
    expect(screen.getByRole("status").textContent).toContain("Checking");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No .* API key is configured/)).toBeNull();
    resolve(catalog("openai", "platform"));
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No .* API key is configured/)).toBeNull();
  });

  it("suppresses stale credential warnings after a failed catalog refetch", async () => {
    localStorage.setItem("cogniplane:model", "openai/test-model");
    vi.mocked(getAdminModelCatalog).mockRejectedValue(new Error("offline"));
    renderPage(catalog("openai", "none"));
    await screen.findByText(/Could not check model availability/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No .* API key is configured/)).toBeNull();
  });

  it("keeps a successful warning visible during background refresh", async () => {
    localStorage.setItem("cogniplane:model", "openai/test-model");
    let resolve!: (value: AdminModelCatalogResponse) => void;
    vi.mocked(getAdminModelCatalog).mockReturnValue(new Promise((done) => { resolve = done; }));
    renderPage(catalog("openai", "none"));
    await screen.findByText("Checking model availability...");
    expect(screen.getByRole("alert").textContent).toContain("No OpenAI API key");
    resolve(catalog("openai", "platform"));
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a catalog error without claiming credentials are missing", async () => {
    vi.mocked(getAdminModelCatalog).mockRejectedValue(new Error("offline"));
    renderPage();
    expect(await screen.findByText(/Could not check model availability/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No .* API key is configured/)).toBeNull();
  });

  it("retries a failed check without reloading and replaces stale credential data", async () => {
    localStorage.setItem("cogniplane:model", "openai/test-model");
    let resolve!: (value: AdminModelCatalogResponse) => void;
    vi.mocked(getAdminModelCatalog)
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    renderPage(catalog("openai", "none"));
    fireEvent.click(await screen.findByRole("button", { name: "Retry model check" }));
    await screen.findByText("Checking model availability...");
    expect(screen.queryByRole("button", { name: "Retry model check" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    resolve(catalog("openai", "platform"));
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getAdminModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("keeps retry available when the next check also fails", async () => {
    vi.mocked(getAdminModelCatalog).mockRejectedValue(new Error("offline"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Retry model check" }));
    await waitFor(() => expect(getAdminModelCatalog).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Retry model check" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
