// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  readError?: string;
  onRetryRead?: () => Promise<void>;
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
      readError={overrides.readError}
      onRetryRead={overrides.onRetryRead}
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
    fireEvent.click(screen.getByRole("button", { name: "Remove Kimi K3 (OpenRouter)" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm model removal" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Remove Kimi K3 (OpenRouter)" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm model removal" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Remove Kimi K3 (OpenRouter)" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm model removal" }));
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
  expect(await screen.findAllByText(/^On, but it needs a key\./)).toHaveLength(3);
  expect(screen.getAllByText(/^On\. 1 model available\./)).toHaveLength(2);
  const anthropic = screen.getByRole("checkbox", { name: "Use Anthropic" });
  fireEvent.click(anthropic);
  expect(screen.getByText(/^Off\. Tick Use and save to show its 1 model\./)).toBeTruthy();
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
  screen.getByRole("button", { name: "Save model availability" }).focus();
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

it("keeps later edits dirty, adopts the saved version, and ignores a second pending Save", async () => {
  let finish!: (value: ModelAvailabilitySaveResult) => void;
  const held = new Promise<ModelAvailabilitySaveResult>(resolve => { finish = resolve; });
  let finishRetry!: (value: ModelAvailabilitySaveResult) => void;
  const heldRetry = new Promise<ModelAvailabilitySaveResult>(resolve => { finishRetry = resolve; });
  const onSave = vi.fn().mockReturnValueOnce(held).mockReturnValueOnce(heldRetry);
  renderCard({ onSave });
  const select = await screen.findByLabelText("Default model");
  fireEvent.change(select, { target: { value: CUSTOM_MODEL_ID } });
  const submit = screen.getByRole("button", { name: "Save model availability" });
  submit.focus();
  fireEvent.click(submit);
  expect(document.activeElement?.textContent).toContain("Saving submitted availability");
  fireEvent.click(submit);
  fireEvent.change(select, { target: { value: "deepagents/claude-sonnet-5" } });
  await act(async () => finish({ saved: { ...settings, version: 9, defaultModelId: CUSTOM_MODEL_ID } }));
  expect((select as HTMLSelectElement).value).toBe("deepagents/claude-sonnet-5");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(screen.getByText(/Your later edits are still unsaved/)).toBeTruthy();
  expect(onSave).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 9, defaultModelId: "deepagents/claude-sonnet-5" }));
  const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);
  fireEvent.click(cancel);
  expect(screen.getByText(/Your later edits are still unsaved/)).toBeTruthy();
  await act(async () => finishRetry(false));
  expect(cancel.disabled).toBe(false);
  fireEvent.click(cancel);
  expect(screen.queryByText(/Your later edits are still unsaved/)).toBeNull();
});

it("keeps focus where the administrator moved it during a Save", async () => {
  let finish!: (value: ModelAvailabilitySaveResult) => void;
  renderCard({ onSave: () => new Promise(resolve => { finish = resolve; }) });
  fireEvent.change(await screen.findByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  const save = screen.getByRole("button", { name: "Save model availability" });
  save.focus();
  fireEvent.click(save);
  const destination = screen.getByRole("button", { name: "Choose models" });
  destination.focus();
  await act(async () => finish(true));
  expect(document.activeElement).toBe(destination);
});

it("reveals owned Save feedback after the sticky bar becomes a completed result", async () => {
  let finish!: (value: ModelAvailabilitySaveResult) => void;
  renderCard({ onSave: () => new Promise(resolve => { finish = resolve; }) });
  fireEvent.change(await screen.findByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  const save = screen.getByRole("button", { name: "Save model availability" });
  const status = screen.getByRole("status");
  const reveal = vi.fn();
  Element.prototype.scrollIntoView = reveal;
  vi.spyOn(status, "getBoundingClientRect").mockImplementation(() => ({ top: status.textContent === "Model availability saved." ? 1500 : 300, bottom: status.textContent === "Model availability saved." ? 1520 : 320 } as DOMRect));
  save.focus();
  fireEvent.click(save);
  expect(reveal).not.toHaveBeenCalled();
  await act(async () => finish(true));
  expect(document.activeElement).toBe(status);
  await waitFor(() => expect(reveal).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "instant" }));
});

it("locks an idle Add form during availability Save without claiming an Add is running", async () => {
  let finish!: (value: ModelAvailabilitySaveResult) => void;
  const { onAddModel } = renderCard({ onSave: () => new Promise(resolve => { finish = resolve; }) });
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  fireEvent.change(screen.getByLabelText("OpenRouter slug"), { target: { value: "sample/idle" } });
  fireEvent.change(screen.getByLabelText("Default model"), { target: { value: CUSTOM_MODEL_ID } });
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
  const form = screen.getByLabelText("OpenRouter slug").closest("form")!;
  expect(form.querySelector("fieldset")?.disabled).toBe(true);
  expect(within(form).getByRole("button", { name: "Add model" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Adding model..." })).toBeNull();
  expect(onAddModel).not.toHaveBeenCalled();
  await act(async () => finish(true));
});

it("requires a named removal decision, holds it pending, and keeps it after failure", async () => {
  let finish!: (value: TenantSettings | null) => void;
  const { onRemoveModel } = renderCard({ settings: { ...settings, defaultModelId: CUSTOM_MODEL_ID, enabledModelIds: [CUSTOM_MODEL_ID] }, onRemoveModel: () => new Promise(resolve => { finish = resolve; }) });
  fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Kimi K3 (OpenRouter)" }));
  expect(onRemoveModel).not.toHaveBeenCalled();
  expect(screen.getByText(/last saved selected model/)).toBeTruthy();
  const confirm = screen.getByRole("button", { name: "Confirm model removal" });
  confirm.focus();
  fireEvent.click(confirm);
  expect(document.activeElement?.textContent).toBe("Removing Kimi K3 (OpenRouter)...");
  fireEvent.click(confirm);
  expect(screen.getByRole("button", { name: "Removing model..." })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Keep model" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish(null));
  expect(onRemoveModel).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toContain("Could not remove Kimi K3");
  expect(screen.getByRole("button", { name: "Confirm model removal" })).toBeTruthy();
});

it.each([false, true])("keeps custom-add focus on its named pending and result feedback, moved elsewhere: %s", async (moveAway) => {
  let finish!: (ok: boolean) => void;
  const { onAddModel } = renderCard({ onAddModel: () => new Promise(resolve => { finish = resolve; }) });
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  fireEvent.change(screen.getByLabelText("OpenRouter slug"), { target: { value: "sample/focus-model" } });
  const submit = within(screen.getByLabelText("OpenRouter slug").closest("form")!).getByRole("button", { name: "Add model" });
  submit.focus();
  fireEvent.click(submit);
  expect(document.activeElement?.textContent).toBe("Adding sample/focus-model...");
  expect(document.activeElement?.getAttribute("role")).toBe("status");
  fireEvent.click(submit);
  const outside = screen.getByRole("button", { name: "Choose models" });
  if (moveAway) outside.focus();
  await act(async () => finish(true));
  expect(onAddModel).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/sample\/focus-model added/)).toBeTruthy();
  expect(document.activeElement).toBe(moveAway ? outside : screen.getByText(/sample\/focus-model added/));
  expect((screen.getByLabelText("OpenRouter slug") as HTMLInputElement).value).toBe("");
});

it("keeps failed-read recovery in the Save status and keeps outside focus after retry", async () => {
  let finish!: () => void;
  const retry = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  renderCard({ readError: "Changes paused. Your draft is kept.", onRetryRead: retry });
  fireEvent.click(screen.getByRole("checkbox", { name: "Use OpenAI" }));
  const recover = screen.getByRole("button", { name: "Retry model data" });
  recover.focus();
  fireEvent.click(recover);
  expect(document.activeElement?.getAttribute("role")).toBe("status");
  expect(document.activeElement?.textContent).toContain("Changes paused. Your draft is kept.");
  const outside = screen.getByRole("button", { name: "Choose models" });
  outside.focus();
  await act(async () => finish());
  expect(retry).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(outside);
});

it("keeps a keyboard suggestion mounted while focus enters it", () => {
  renderCard({ openRouterModels: [{ id: "MixedCase/Exact-Slug", name: "Keyboard model", contextLength: 200000 }] });
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  const input = screen.getByLabelText("OpenRouter slug");
  fireEvent.change(input, { target: { value: "key" } });
  const suggestion = screen.getByRole("button", { name: /Keyboard model/ });
  fireEvent.blur(input, { relatedTarget: suggestion });
  suggestion.focus();
  expect(document.activeElement).toBe(suggestion);
  fireEvent.click(suggestion);
  expect((input as HTMLInputElement).value).toBe("MixedCase/Exact-Slug");
});

it("checks the integer context limits and exact slug before submitting manual metadata", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const { onAddModel } = renderCard({ onAddModel: async () => false });
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
  fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
  const slug = screen.getByLabelText("Vendor model id");
  const context = screen.getByLabelText("Context window");
  const submit = screen.getAllByRole("button", { name: "Add model" }).at(-1) as HTMLButtonElement;
  fireEvent.change(slug, { target: { value: " MixedCase/Exact-Slug " } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Sample model" } });
  for (const value of ["999", "1000.5", "100000001"]) {
    fireEvent.change(context, { target: { value } });
    expect(submit.disabled).toBe(true);
  }
  fireEvent.change(context, { target: { value: "1000" } });
  for (const value of ["x".repeat(151), "model with space", "../model"]) {
    fireEvent.change(slug, { target: { value } });
    expect(submit.disabled).toBe(true);
  }
  fireEvent.change(slug, { target: { value: " MixedCase/Exact-Slug " } });
  fireEvent.click(submit);
  await waitFor(() => expect(onAddModel).toHaveBeenCalledWith({ provider: "openai", vendorModelId: "MixedCase/Exact-Slug", displayName: "Sample model", contextWindow: 1000 }));
});

it.each([null, []] as const)("keeps the saved all-model versus empty-list distinction: %s", async (enabledModelIds) => {
  const { onSave } = renderCard({ settings: { ...settings, enabledModelIds: enabledModelIds as string[] | null } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Use OpenAI" }));
  fireEvent.click(screen.getByRole("button", { name: "Save model availability" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ enabledModelIds })));
});
