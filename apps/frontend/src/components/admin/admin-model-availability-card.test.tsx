// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdminModelCatalogResponse,
  TenantSettings
} from "@cogniplane/shared-types";

import { AdminModelAvailabilityCard } from "./admin-model-availability-card";

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
  modelDefaultEfforts: {},
  version: 1,
  configHash: "h",
  updatedAt: new Date().toISOString()
} as unknown as TenantSettings;

function renderCard(overrides: {
  onSave?: (input: unknown) => Promise<boolean>;
  onRemoveModel?: (modelId: string) => Promise<boolean>;
} = {}) {
  const onSave = vi.fn(overrides.onSave ?? (async () => true));
  const onRemoveModel = vi.fn(overrides.onRemoveModel ?? (async () => true));
  render(
    <AdminModelAvailabilityCard
      catalog={catalog}
      settings={settings}
      saving={false}
      onSave={onSave as never}
      adding={false}
      addError={null}
      openRouterModels={null}
      openRouterLoadError={null}
      onNeedOpenRouterModels={() => {}}
      onAddModel={async () => true}
      onRemoveModel={onRemoveModel}
    />
  );
  return { onSave, onRemoveModel };
}

afterEach(() => {
  cleanup();
});

describe("AdminModelAvailabilityCard custom-model removal", () => {
  it("strips a removed custom model from a dirty draft so Save cannot submit it", async () => {
    const { onSave, onRemoveModel } = renderCard();

    // Dirty the draft with an unrelated edit (disable the OpenAI provider).
    fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/i }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Remove the custom model (Codex P2: previously the dirty draft kept the
    // deleted id in enabledModelIds and the next Save got a 400).
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onRemoveModel).toHaveBeenCalledWith(CUSTOM_MODEL_ID));

    fireEvent.click(screen.getByRole("button", { name: /Save model availability/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as {
      enabledModelIds: string[] | null;
      modelDefaultEfforts: Record<string, string>;
    };
    expect(saved.enabledModelIds).toEqual(["deepagents/claude-sonnet-5"]);
    expect(saved.modelDefaultEfforts).toEqual({});
  });

  it("keeps the draft intact when removal fails", async () => {
    const { onSave, onRemoveModel } = renderCard({ onRemoveModel: async () => false });

    fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onRemoveModel).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Save model availability/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as { enabledModelIds: string[] | null };
    // Removal failed server-side, so the model must stay in the allowlist.
    expect(saved.enabledModelIds).toContain(CUSTOM_MODEL_ID);
  });
});
