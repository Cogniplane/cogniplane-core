// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdminModelCatalogResponse,
  CustomModelCreateRequest,
  OpenRouterModelOption,
  TenantSettings
} from "@cogniplane/shared-types";

import { AdminModelAvailabilityCard, type ModelAvailabilitySaveResult } from "./admin-model-availability-card";

const CUSTOM_MODEL_ID = "openrouter/moonshotai/kimi-k3";

const catalog: AdminModelCatalogResponse = {
  models: [
    {
      id: "deepagents/claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      description: "Builtin model.",
      isDefault: true,
      provider: "anthropic",
      supportedEfforts: ["none", "low", "medium", "high"],
      defaultEffort: "none",
      contextWindow: 1_000_000,
      source: "builtin"
    },
    {
      id: CUSTOM_MODEL_ID,
      displayName: "Kimi K3 (OpenRouter)",
      description: "Custom model.",
      isDefault: false,
      provider: "openrouter",
      supportedEfforts: [],
      defaultEffort: null,
      contextWindow: 262_144,
      source: "custom"
    }
  ],
  providers: [
    { id: "anthropic", label: "Anthropic", keySource: "platform" },
    { id: "openai", label: "OpenAI", keySource: "none" },
    { id: "google", label: "Google", keySource: "none" },
    { id: "openrouter", label: "OpenRouter", keySource: "tenant" },
    { id: "zai", label: "Z.AI", keySource: "none" }
  ]
};

// Custom-selection mode with BOTH models allowlisted, so the removed model id
// is present in the draft.
const settings = {
  tenantId: "t",
  showEffortSelector: true,
  enabledProviders: ["anthropic", "openai", "google", "openrouter", "zai"],
  enabledModelIds: ["deepagents/claude-sonnet-5", CUSTOM_MODEL_ID],
  defaultModelId: null,
  modelDefaultEfforts: {},
  version: 1,
  configHash: "h",
  updatedAt: new Date().toISOString()
} as unknown as TenantSettings;

const providerKeys = { tenant: null, busyKey: null, providerSuccessMessage: {}, providerErrorMessage: {}, onSaveProviderKey: async () => true };

function renderCard(overrides: {
  onSave?: (input: unknown) => Promise<ModelAvailabilitySaveResult>;
  onRemoveModel?: (modelId: string) => Promise<TenantSettings | null>;
  settings?: TenantSettings;
  catalog?: AdminModelCatalogResponse;
  targetProvider?: "openai";
  saveError?: string;
  openRouterModels?: OpenRouterModelOption[];
  onAddModel?: (input: CustomModelCreateRequest) => Promise<boolean>;
} = {}) {
  const onSave = vi.fn(overrides.onSave ?? (async () => true));
  const onRemoveModel = vi.fn(overrides.onRemoveModel ?? (async () => ({ ...settings, version: settings.version + 1 })));
  const onAddModel = vi.fn(overrides.onAddModel ?? (async () => true));
  const onNeedOpenRouterModels = vi.fn();
  render(
    <AdminModelAvailabilityCard
      catalog={overrides.catalog ?? catalog}
      settings={overrides.settings ?? settings}
      saving={false}
      onSave={onSave as never}
      adding={false}
      addError={null}
      openRouterModels={overrides.openRouterModels ?? null}
      openRouterLoadError={null}
      onNeedOpenRouterModels={onNeedOpenRouterModels}
      onAddModel={onAddModel}
      onRemoveModel={onRemoveModel}
      providerKeys={{ ...providerKeys, targetProvider: overrides.targetProvider }}
      saveError={overrides.saveError ?? null}
    />
  );
  return { onSave, onRemoveModel, onAddModel, onNeedOpenRouterModels };
}

// jsdom has no scrollIntoView; Radix Select calls it. Restore after each test.
const originalScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

it("keeps the draft version after a background refetch", async () => {
  const onSave = vi.fn(async () => false);
  const props = {
    catalog,
    saving: false,
    onSave,
    adding: false,
    addError: null,
    openRouterModels: null,
    openRouterLoadError: null,
    onNeedOpenRouterModels: () => {},
    onAddModel: async () => true,
    onRemoveModel: async () => settings,
    providerKeys,
    saveError: null
  };
  const view = render(<AdminModelAvailabilityCard {...props} settings={settings} />);
  fireEvent.change(screen.getByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  view.rerender(<AdminModelAvailabilityCard {...props} settings={{ ...settings, version: 2, defaultModelId: "deepagents/claude-sonnet-5" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, defaultModelId: CUSTOM_MODEL_ID })));
});

it("explains the effective fallback when a saved default is unavailable", async () => {
  renderCard({ settings: { ...settings, defaultModelId: "openai/retired" } });
  expect(await screen.findByText(/The saved default is unavailable. New chats use Claude Sonnet 5/)).toBeTruthy();
});

describe("AdminModelAvailabilityCard custom-model removal", () => {
  it("clears the organization default when its custom model is removed", async () => {
    const { onSave } = renderCard({ settings: { ...settings, defaultModelId: CUSTOM_MODEL_ID } });
    fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect((screen.getByLabelText("Default model") as HTMLSelectElement).value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ defaultModelId: null })));
  });

  it("strips a removed custom model from a dirty draft so Save cannot submit it", async () => {
    const { onSave, onRemoveModel } = renderCard({
      // The removal saves tenant settings, so their version moves.
      onRemoveModel: async () => ({ ...settings, version: 7 }),
      catalog: {
        ...catalog,
        models: catalog.models.map((model) => model.id === CUSTOM_MODEL_ID
          ? { ...model, supportedEfforts: ["low", "high"], defaultEffort: "low" }
          : model)
      },
      settings: {
        ...settings,
        modelDefaultEfforts: {
          [CUSTOM_MODEL_ID]: "high",
          "deepagents/claude-sonnet-5": "medium"
        }
      }
    });

    // Dirty the draft with an unrelated edit (disable the OpenAI provider).
    fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/i }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Remove the custom model (Codex P2: previously the dirty draft kept the
    // deleted id in enabledModelIds and the next Save got a 400).
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onRemoveModel).toHaveBeenCalledWith(CUSTOM_MODEL_ID));

    fireEvent.click(screen.getByRole("button", { name: /Save model availability/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as {
      expectedVersion: number;
      enabledModelIds: string[] | null;
      modelDefaultEfforts: Record<string, string>;
    };
    // Without the new version the save gets a 409 that only Cancel can clear.
    expect(saved.expectedVersion).toBe(7);
    expect(saved.enabledModelIds).toEqual(["deepagents/claude-sonnet-5"]);
    expect(saved.modelDefaultEfforts).toEqual({ "deepagents/claude-sonnet-5": "medium" });
  });

  it("keeps the draft intact when removal fails", async () => {
    const { onSave, onRemoveModel } = renderCard({ onRemoveModel: async () => null });

    fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onRemoveModel).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Save model availability/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as { enabledModelIds: string[] | null };
    // Removal failed server-side, so the model must stay in the allowlist.
    expect(saved.enabledModelIds).toContain(CUSTOM_MODEL_ID);
  });
});


it("keeps the draft after a save conflict and saves it again on the newer version", async () => {
  const onSave = vi.fn<(input: unknown) => Promise<ModelAvailabilitySaveResult>>()
    .mockResolvedValueOnce({ conflict: { ...settings, version: 4 } })
    .mockResolvedValue(true);
  renderCard({ onSave, saveError: "Tenant settings changed." });
  fireEvent.change(await screen.findByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));

  const status = screen.getByRole("status");
  await waitFor(() => expect(status.textContent).toContain("Settings changed to v4"));
  // The raw 409 message does not show. The draft stays and Save is offered again.
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByLabelText("Default model") as HTMLSelectElement).value).toBe(CUSTOM_MODEL_ID);
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  expect(onSave).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedVersion: 1 }));
  expect(onSave).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedVersion: 4, defaultModelId: CUSTOM_MODEL_ID }));
  await waitFor(() => expect(status.textContent).toBe("Model availability saved."));
});

it("asks before the page unloads only while the draft has changes", async () => {
  const unloadPrevented = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  renderCard();
  fireEvent.change(await screen.findByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  expect(unloadPrevented()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(unloadPrevented()).toBe(false);
});

it("names the model on each effort select", async () => {
  renderCard();
  fireEvent.click(screen.getByRole("button", { name: "Edit effort" }));
  expect(screen.getByRole("combobox", { name: "Default effort for Claude Sonnet 5" })).toBeTruthy();
});

it("can cancel a changed default without saving", async () => {
  const { onSave } = renderCard();
  const select = await screen.findByLabelText("Default model");
  fireEvent.change(select, { target: { value: CUSTOM_MODEL_ID } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect((select as HTMLSelectElement).value).toBe("");
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(onSave).not.toHaveBeenCalled();
});

it("summarizes the models and hides the save bar until something changes", async () => {
  renderCard();
  expect(await screen.findByText("2 of 2 models available from 2 providers.")).toBeTruthy();
  expect(screen.getByText("New chats start with Claude Sonnet 5.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save model availability" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/i }));
  expect(screen.getByRole("button", { name: "Save model availability" })).toBeTruthy();
});

it("shows each provider's on/off choice and selected model count, and saves the choice with the draft", async () => {
  const { onSave } = renderCard();
  expect(await screen.findAllByText("On, but it needs a key.")).toHaveLength(3);
  expect(screen.getAllByText("On. 1 model available.")).toHaveLength(2);
  const anthropic = screen.getByRole("checkbox", { name: "Use Anthropic" });
  fireEvent.click(anthropic);
  expect(screen.getByText("Off. Tick Use and save to show its 1 model.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ enabledProviders: ["openai", "google", "openrouter", "zai"] })));
});

it("opens and focuses the key form a provider link points to", async () => {
  renderCard({ targetProvider: "openai" });
  const button = await screen.findByRole("button", { name: "Set up OpenAI key" });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(button);
  expect(screen.getByLabelText("OpenAI API key").closest("[hidden]")).toBeNull();
  expect(screen.getByRole("button", { name: "Choose models" }).getAttribute("aria-expanded")).toBe("false");
});

it("shows a failed save next to the save buttons and clears it on Cancel", async () => {
  renderCard({ saveError: "Failed to save model availability.", onSave: async () => false });
  fireEvent.change(await screen.findByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  // The page keeps an old error, but none shows before this draft is saved.
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Failed to save model availability.");
  // The error sits in the same bar as the button that retries the save.
  expect(alert.parentElement?.contains(screen.getByRole("button", { name: "Save model availability" }))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("status"));
  // A new edit after Cancel does not bring the old error back.
  fireEvent.change(screen.getByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("announces a successful save and keeps focus on the page", async () => {
  renderCard();
  fireEvent.change(await screen.findByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Unsaved changes");
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
  await waitFor(() => expect(status.textContent).toBe("Model availability saved."));
  expect(document.activeElement).toBe(status);
});

describe("AdminModelAvailabilityCard add custom model", () => {
  const openRouterModels = Array.from({ length: 10 }, (_, i) => ({
    id: `moonshotai/kimi-k${i}`, name: `Kimi K${i}`, contextLength: 262_144
  })) as OpenRouterModelOption[];

  function openAddForm() {
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  }

  it("suggests at most eight OpenRouter matches and submits the picked slug", async () => {
    const { onAddModel, onNeedOpenRouterModels } = renderCard({ openRouterModels });
    openAddForm();
    expect(onNeedOpenRouterModels).toHaveBeenCalled();

    const slug = screen.getByLabelText("OpenRouter slug");
    fireEvent.change(slug, { target: { value: "k" } });
    expect(screen.queryByText("Kimi K0")).toBeNull();
    fireEvent.change(slug, { target: { value: "kimi" } });
    expect(screen.getAllByRole("button", { name: /moonshotai\/kimi-k/ })).toHaveLength(8);

    fireEvent.click(screen.getByRole("button", { name: /Kimi K3/ }));
    expect((slug as HTMLInputElement).value).toBe("moonshotai/kimi-k3");
    fireEvent.click(screen.getAllByRole("button", { name: "Add model" }).at(-1)!);

    await waitFor(() => expect(onAddModel).toHaveBeenCalledWith({ provider: "openrouter", vendorModelId: "moonshotai/kimi-k3" }));
    await waitFor(() => expect((slug as HTMLInputElement).value).toBe(""));
  });

  it("requires a display name and context window for a provider without a catalog", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { onAddModel } = renderCard({ onAddModel: async () => false });
    openAddForm();
    fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));

    const submit = screen.getAllByRole("button", { name: "Add model" }).at(-1) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Vendor model id"), { target: { value: " gpt-6-preview " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: " GPT-6 Preview " } });
    fireEvent.change(screen.getByLabelText("Context window"), { target: { value: "0" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Context window"), { target: { value: "400000" } });
    fireEvent.click(submit);

    await waitFor(() => expect(onAddModel).toHaveBeenCalledWith({
      provider: "openai", vendorModelId: "gpt-6-preview", displayName: "GPT-6 Preview", contextWindow: 400_000
    }));
    // The add failed, so the admin keeps the input to correct it.
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe(" GPT-6 Preview ");
  });
});
