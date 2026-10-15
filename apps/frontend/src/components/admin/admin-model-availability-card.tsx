"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import type {
  AdminModelCatalogResponse,
  CustomModelCreateRequest,
  EffortLevel,
  Model,
  ModelProvider,
  OpenRouterModelOption,
  TenantSettings
} from "@cogniplane/shared-types";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { useConfirmLeave } from "../../hooks/use-confirm-leave";
import { CHIP, HINT, PILL_GRAY } from "../../lib/ui-tokens";
import { ProviderKeyRows } from "./provider-key-rows";
import { DisclosureRow } from "./overview-row";
import { SaveBar } from "./save-bar";

export type ModelAvailabilityInput = {
  expectedVersion: number;
  enabledProviders: ModelProvider[];
  enabledModelIds: string[] | null;
  defaultModelId: string | null;
  modelDefaultEfforts: Record<string, EffortLevel>;
  showEffortSelector: boolean;
};

/**
 * The result of a save. `conflict` means that other settings were saved first,
 * and holds the settings that the page loaded again.
 */
export type ModelAvailabilitySaveResult = boolean | { conflict: TenantSettings };

type Draft = {
  expectedVersion: number;
  enabledProviders: ModelProvider[];
  // "all" keeps enabledModelIds null server-side; "custom" persists the list.
  modelSelectionMode: "all" | "custom";
  enabledModelIds: string[];
  defaultModelId: string | null;
  modelDefaultEfforts: Record<string, EffortLevel>;
  showEffortSelector: boolean;
};

function buildDraft(settings: TenantSettings): Draft {
  return {
    expectedVersion: settings.version,
    enabledProviders: settings.enabledProviders,
    modelSelectionMode: settings.enabledModelIds === null ? "all" : "custom",
    enabledModelIds: settings.enabledModelIds ?? [],
    defaultModelId: settings.defaultModelId,
    modelDefaultEfforts: { ...settings.modelDefaultEfforts },
    showEffortSelector: settings.showEffortSelector
  };
}

function EffortSelect(props: {
  model: Model;
  value: EffortLevel | null;
  disabled: boolean;
  onChange: (effort: EffortLevel) => void;
}) {
  const { model } = props;
  if (model.supportedEfforts.length < 2) {
    return <span className="text-xs text-on-surface-faint">—</span>;
  }
  const effective = props.value ?? model.defaultEffort ?? model.supportedEfforts[0];
  return (
    <Select
      value={effective ?? undefined}
      disabled={props.disabled}
      onValueChange={(next) => props.onChange(next as EffortLevel)}
    >
      <SelectTrigger size="sm" aria-label={`Default effort for ${model.displayName}`} className="h-7 w-32 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {model.supportedEfforts.map((effort) => (
          <SelectItem key={effort} value={effort} className="text-xs">
            {effort}
            {effort === model.defaultEffort ? " (default)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const ROW = "flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between";

/**
 * "Add custom model" form. OpenRouter gets a type-ahead over the server-
 * proxied public catalog (slug + metadata auto-fill happen backend-side);
 * other providers take manual metadata since no key-free lookup exists.
 */
function AddCustomModelForm(props: {
  adding: boolean;
  addError: string | null;
  openRouterModels: OpenRouterModelOption[] | null;
  openRouterLoadError: string | null;
  onNeedOpenRouterModels: () => void;
  onAdd: (input: CustomModelCreateRequest) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState<ModelProvider>("openrouter");
  const [vendorModelId, setVendorModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const needsManualMetadata = provider !== "openrouter";

  // Lazy-load the OpenRouter catalog the first time the picker is relevant.
  const { onNeedOpenRouterModels } = props;
  useEffect(() => {
    if (provider === "openrouter") onNeedOpenRouterModels();
  }, [provider, onNeedOpenRouterModels]);

  const suggestions = useMemo(() => {
    if (provider !== "openrouter" || !props.openRouterModels) return [];
    const query = vendorModelId.trim().toLowerCase();
    if (query.length < 2) return [];
    return props.openRouterModels
      .filter(
        (option) =>
          option.id.toLowerCase().includes(query) || option.name.toLowerCase().includes(query)
      )
      .slice(0, 8);
  }, [provider, props.openRouterModels, vendorModelId]);

  const canSubmit =
    vendorModelId.trim().length > 0 &&
    (!needsManualMetadata || (displayName.trim().length > 0 && Number(contextWindow) > 0));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const added = await props.onAdd({
      provider,
      vendorModelId: vendorModelId.trim(),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(needsManualMetadata && Number(contextWindow) > 0
        ? { contextWindow: Number(contextWindow) }
        : {})
    });
    if (added) {
      setVendorModelId("");
      setDisplayName("");
      setContextWindow("");
    }
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-lowest p-3"
      onSubmit={handleSubmit}
    >
      <div>
        <p className="text-sm font-semibold text-on-surface">Add a model</p>
        <p className="mt-0.5 text-xs text-on-surface-faint">
          {provider === "openrouter"
            ? "Search OpenRouter by slug or name — metadata is validated and filled in automatically."
            : `Add any ${MODEL_PROVIDER_META[provider].label} model id. Display name and context window are required (there is no catalog to look them up from).`}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="custom-model-provider">Provider</Label>
          <Select
            value={provider}
            onValueChange={(next) => {
              setProvider(next as ModelProvider);
              setPickerOpen(false);
            }}
          >
            <SelectTrigger id="custom-model-provider" size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {MODEL_PROVIDER_META[p].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="relative flex min-w-64 flex-1 flex-col gap-1.5">
          <Label htmlFor="custom-model-id">
            {provider === "openrouter" ? "OpenRouter slug" : "Vendor model id"}
          </Label>
          <Input
            id="custom-model-id"
            autoComplete="off"
            value={vendorModelId}
            placeholder={provider === "openrouter" ? "moonshotai/kimi-k3" : "model-id"}
            onChange={(e) => {
              setVendorModelId(e.target.value);
              setPickerOpen(true);
            }}
            onBlur={() => {
              // Delay so a click on a suggestion lands before the list hides.
              setTimeout(() => setPickerOpen(false), 150);
            }}
          />
          {pickerOpen && suggestions.length > 0 ? (
            <ul className="absolute top-full z-10 mt-1 w-full overflow-hidden rounded-md border border-outline-variant bg-surface shadow-md">
              {suggestions.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-container"
                    onClick={() => {
                      setVendorModelId(option.id);
                      setPickerOpen(false);
                    }}
                  >
                    <span className="text-sm text-on-surface">{option.name}</span>
                    <span className="text-xs text-on-surface-faint">
                      {option.id}
                      {option.contextLength
                        ? ` — ${Math.round(option.contextLength / 1000)}k context`
                        : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {needsManualMetadata ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="custom-model-name">Display name</Label>
              <Input
                id="custom-model-name"
                autoComplete="off"
                className="w-44"
                value={displayName}
                placeholder="GPT-6 Preview"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="custom-model-context">Context window</Label>
              <Input
                id="custom-model-context"
                autoComplete="off"
                className="w-32"
                type="number"
                min={1000}
                value={contextWindow}
                placeholder="400000"
                onChange={(e) => setContextWindow(e.target.value)}
              />
            </div>
          </>
        ) : null}

        <Button type="submit" disabled={props.adding || !canSubmit}>
          {props.adding ? "Adding..." : "Add model"}
        </Button>
      </div>

      {provider === "openrouter" && props.openRouterLoadError ? (
        <p className="text-xs text-warning">
          {props.openRouterLoadError} You can still submit an exact slug.
        </p>
      ) : null}
      {props.addError ? <p className="text-sm text-danger">{props.addError}</p> : null}
    </form>
  );
}

export function AdminModelAvailabilityCard(props: {
  catalog: AdminModelCatalogResponse | null;
  settings: TenantSettings | null;
  saving: boolean;
  onSave: (input: ModelAvailabilityInput) => Promise<ModelAvailabilitySaveResult>;
  adding: boolean;
  addError: string | null;
  openRouterModels: OpenRouterModelOption[] | null;
  openRouterLoadError: string | null;
  onNeedOpenRouterModels: () => void;
  onAddModel: (input: CustomModelCreateRequest) => Promise<boolean>;
  /** Returns the saved settings after the removal, or null when it failed. */
  onRemoveModel: (modelId: string) => Promise<TenantSettings | null>;
  /** The provider key forms. Each shares its row with the provider on/off choice in this draft. */
  providerKeys: Omit<ComponentProps<typeof ProviderKeyRows>, "providerStatuses" | "status" | "actions">;
  saveError: string | null;
}) {
  const { catalog, settings } = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [customModelOpen, setCustomModelOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  // The page keeps the last mutation error. Show it only for this draft's last save.
  const [saveFailed, setSaveFailed] = useState(false);
  // The newer version that the draft moved to after a save conflict.
  const [rebasedVersion, setRebasedVersion] = useState<number | null>(null);
  useConfirmLeave(isDirty);

  // Seed/resync the draft from the server state unless the admin has local
  // edits in flight.
  useEffect(() => {
    if (settings && !isDirty) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(buildDraft(settings));
    }
  }, [settings, isDirty]);

  const modelsByProvider = useMemo(() => {
    const groups = new Map<ModelProvider, Model[]>();
    for (const model of catalog?.models ?? []) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }
    return groups;
  }, [catalog]);

  if (!catalog || !settings || !draft) {
    return null;
  }

  function updateDraft(recipe: (current: Draft) => Draft): void {
    setIsDirty(true);
    setShowSuccess(false);
    setSaveFailed(false);
    setDraft((current) => (current ? recipe(current) : current));
  }

  const toggleProvider = (provider: ModelProvider, enabled: boolean) =>
    updateDraft((current) => ({
      ...current,
      defaultModelId: !enabled && catalog.models.some((model) => model.id === current.defaultModelId && model.provider === provider)
        ? null : current.defaultModelId,
      enabledProviders: enabled
        ? [...current.enabledProviders, provider]
        : current.enabledProviders.filter((p) => p !== provider)
    }));

  const toggleModel = (modelId: string, enabled: boolean) =>
    updateDraft((current) => ({
      ...current,
      defaultModelId: !enabled && current.defaultModelId === modelId ? null : current.defaultModelId,
      enabledModelIds: enabled
        ? [...current.enabledModelIds, modelId]
        : current.enabledModelIds.filter((id) => id !== modelId)
    }));

  const handleRemoveModel = async (modelId: string) => {
    const updated = await props.onRemoveModel(modelId);
    if (!updated) return;
    // The backend scrubbed the deleted model from tenant_settings, but the
    // resync effect deliberately ignores server state while the draft is
    // dirty — strip the id locally so a later Save can't submit a reference
    // to the deleted model (the PUT rejects unknown ids with a 400). Plain
    // setDraft, NOT updateDraft: removal alone must not mark a clean draft
    // dirty (server state already matches). The removal saved a new settings
    // version, so a later Save must expect that version.
    setDraft((current) => {
      if (!current) return current;
      const { [modelId]: _removed, ...remainingEfforts } = current.modelDefaultEfforts;
      return {
        ...current,
        expectedVersion: updated.version,
        defaultModelId: current.defaultModelId === modelId ? null : current.defaultModelId,
        enabledModelIds: current.enabledModelIds.filter((id) => id !== modelId),
        modelDefaultEfforts: remainingEfforts
      };
    });
  };

  const setModelEffort = (model: Model, effort: EffortLevel) =>
    updateDraft((current) => {
      const next = { ...current.modelDefaultEfforts };
      // Picking the catalog default clears the override instead of storing a
      // redundant entry (keeps the settings row minimal and future-proof).
      if (effort === model.defaultEffort) {
        delete next[model.id];
      } else {
        next[model.id] = effort;
      }
      return { ...current, modelDefaultEfforts: next };
    });

  const customEmpty =
    draft.modelSelectionMode === "custom" && draft.enabledModelIds.length === 0;
  const usableModels = catalog.models.filter((model) =>
    draft.enabledProviders.includes(model.provider) &&
    catalog.providers.some((provider) => provider.id === model.provider && provider.keySource !== "none") &&
    (draft.modelSelectionMode === "all" || draft.enabledModelIds.includes(model.id))
  );
  const effectiveDefault = usableModels.find((model) => model.id === draft.defaultModelId)
    ?? usableModels.find((model) => model.isDefault)
    ?? usableModels[0];
  const usableProviderCount = new Set(usableModels.map((model) => model.provider)).size;
  const customCount = catalog.models.filter((model) => model.source === "custom").length;

  const handleSave = async () => {
    const saved = await props.onSave({
      expectedVersion: draft.expectedVersion,
      enabledProviders: draft.enabledProviders,
      enabledModelIds: draft.modelSelectionMode === "all" ? null : draft.enabledModelIds,
      defaultModelId: draft.defaultModelId,
      modelDefaultEfforts: draft.modelDefaultEfforts,
      showEffortSelector: draft.showEffortSelector
    });
    if (typeof saved === "object") {
      // This page saves only the fields in the draft. So keep them all and move
      // the draft to the newer version. The administrator saves again.
      setDraft((current) => (current ? { ...current, expectedVersion: saved.conflict.version } : current));
      setRebasedVersion(saved.conflict.version);
      setSaveFailed(false);
      return;
    }
    setSaveFailed(!saved);
    if (saved) {
      setIsDirty(false);
      setShowSuccess(true);
      setRebasedVersion(null);
      statusRef.current?.focus();
    }
  };

  return (
    <div>
    <section aria-labelledby="models-heading">
      <h2 id="models-heading" className="text-lg font-semibold text-on-surface">Model settings</h2>
      <div className="mt-2 divide-y divide-outline-variant border-t border-outline-variant">
        <div className={ROW}>
          <div className="min-w-0">
            <h3 id="default-model-heading" className="font-medium">Default model</h3>
            <p className="mt-1 text-sm text-on-surface-variant" role={draft.defaultModelId && !usableModels.some((model) => model.id === draft.defaultModelId) ? "status" : undefined}>
              {draft.defaultModelId && !usableModels.some((model) => model.id === draft.defaultModelId)
                ? `The saved default is unavailable. New chats use ${effectiveDefault?.displayName ?? "no model"} until you choose an available default.`
                : `New chats start with ${effectiveDefault?.displayName ?? "no model"}.`}
            </p>
          </div>
          <select id="organization-default-model" aria-labelledby="default-model-heading" className="h-8 rounded-md border border-outline-variant bg-surface-container-lowest px-2 text-sm sm:w-64" value={draft.defaultModelId ?? ""} onChange={(event) => updateDraft((current) => ({ ...current, defaultModelId: event.target.value || null }))}>
            <option value="">Catalog default</option>
            {usableModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {MODEL_PROVIDER_META[model.provider].label}</option>)}
          </select>
        </div>
        <DisclosureRow title="Available models" action="Choose models" status={customEmpty ? "No models selected. Members have nothing to pick."
          : usableModels.length === 0 ? "No usable models yet. Set up a provider key below, then enable its models."
            : `${usableModels.length} of ${catalog.models.length} models available from ${usableProviderCount} provider${usableProviderCount === 1 ? "" : "s"}.`}>
        <section className="flex flex-col gap-3">
          <div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="radio"
                  name="model-selection-mode"
                  checked={draft.modelSelectionMode === "all"}
                  onChange={() =>
                    updateDraft((current) => ({ ...current, modelSelectionMode: "all" }))
                  }
                  className="size-4 accent-primary"
                />
                <span>
                  <strong className="font-semibold">All models</strong>{" "}
                  <span className="text-xs text-on-surface-faint">
                    — newly released models become available automatically
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="radio"
                  name="model-selection-mode"
                  checked={draft.modelSelectionMode === "custom"}
                  onChange={() =>
                    updateDraft((current) => ({
                      ...current,
                      modelSelectionMode: "custom",
                      // Seed the allowlist with everything so switching modes
                      // doesn't silently disable models.
                      enabledModelIds:
                        current.enabledModelIds.length > 0
                          ? current.enabledModelIds
                          : catalog.models.map((m) => m.id)
                    }))
                  }
                  className="size-4 accent-primary"
                />
                <span>
                  <strong className="font-semibold">Only selected models</strong>
                </span>
              </label>
            </div>
          </div>

          {customEmpty ? (
            <p className="rounded border border-outline-variant bg-warning-surface px-3 py-2 text-sm text-warning">
              No models selected — members will have nothing to pick in the model selector.
            </p>
          ) : null}

          <div className="flex flex-col gap-4">
            {catalog.providers.map((status) => {
              const models = modelsByProvider.get(status.id) ?? [];
              if (models.length === 0) return null;
              const providerEnabled = draft.enabledProviders.includes(status.id);
              return (
                <div key={status.id} className={providerEnabled ? "" : "opacity-50"}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-sm font-semibold text-on-surface">{status.label}</span>
                    {!providerEnabled ? <span className={PILL_GRAY}>provider off</span>
                      : status.keySource === "none" ? <span className={PILL_GRAY}>hidden until a key is set up</span> : null}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {models.map((model) => {
                      const checked =
                        draft.modelSelectionMode === "all" ||
                        draft.enabledModelIds.includes(model.id);
                      return (
                        <div
                          key={model.id}
                          className="flex flex-wrap items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2"
                        >
                          <input
                            type="checkbox"
                            aria-label={model.displayName}
                            checked={checked}
                            disabled={draft.modelSelectionMode === "all" || !providerEnabled}
                            onChange={(e) => toggleModel(model.id, e.target.checked)}
                            className="size-4 rounded border-outline-variant accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 text-sm font-medium text-on-surface">
                              {model.displayName}
                              {model.source === "custom" ? (
                                <span className={CHIP}>custom</span>
                              ) : null}
                            </span>
                            <span className="block truncate text-xs text-on-surface-faint">
                              {model.description}
                            </span>
                          </span>
                          <div className="flex items-center gap-1.5">
                            {model.supportedEfforts.length >= 2 ? (
                              <span className="text-xs text-on-surface-faint">effort</span>
                            ) : null}
                            {model.source === "custom" ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="text-danger"
                                onClick={() => void handleRemoveModel(model.id)}
                              >
                                Remove
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          </section>
        </DisclosureRow>
        <DisclosureRow title="Reasoning effort" action="Edit effort" status={draft.showEffortSelector ? "Members can choose the effort in the chat picker." : "Chats use each model's default effort."}>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.showEffortSelector} onChange={(event) => updateDraft((current) => ({ ...current, showEffortSelector: event.target.checked }))} /> Show reasoning effort in the chat picker</label>
          {catalog.models.filter((model) => model.supportedEfforts.length > 1).map((model) => <div key={model.id} className="flex items-center justify-between gap-2 text-sm"><span>{model.displayName}</span><EffortSelect model={model} value={draft.modelDefaultEfforts[model.id] ?? null} disabled={false} onChange={(effort) => setModelEffort(model, effort)} /></div>)}
        </DisclosureRow>
        <DisclosureRow title="Custom models" action="Add model" status={customCount ? `${customCount} custom model${customCount === 1 ? "" : "s"}. Remove them in Choose models.` : "No custom models."} onOpenChange={setCustomModelOpen}>
          {customModelOpen ? <AddCustomModelForm
            adding={props.adding}
            addError={props.addError}
            openRouterModels={props.openRouterModels}
            openRouterLoadError={props.openRouterLoadError}
            onNeedOpenRouterModels={props.onNeedOpenRouterModels}
            onAdd={props.onAddModel}
          /> : null}
        </DisclosureRow>
      </div>
    </section>

    <section aria-labelledby="providers-heading" className="mt-10">
      <h2 id="providers-heading" className="text-lg font-semibold text-on-surface">Providers</h2>
      <div className="mt-2">
        <ProviderKeyRows
          {...props.providerKeys}
          providerStatuses={catalog.providers}
          status={(provider) => {
            const selected = (modelsByProvider.get(provider) ?? []).filter((model) => draft.modelSelectionMode === "all" || draft.enabledModelIds.includes(model.id)).length;
            const models = `${selected} model${selected === 1 ? "" : "s"}`;
            if (!draft.enabledProviders.includes(provider)) return selected ? `Off. Tick Use and save to show its ${models}.` : "Off.";
            if (!catalog.providers.some((status) => status.id === provider && status.keySource !== "none")) {
              return selected ? `On, but its ${models} ${selected === 1 ? "stays" : "stay"} hidden until a key is set up.` : "On, but it needs a key.";
            }
            return `On. ${models} available.`;
          }}
          actions={(provider) => (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={`Use ${MODEL_PROVIDER_META[provider].label}`}
                checked={draft.enabledProviders.includes(provider)}
                onChange={(event) => toggleProvider(provider, event.target.checked)}
                className="size-4 accent-primary"
              />
              Use
            </label>
          )}
        />
      </div>
    </section>

      <SaveBar
        dirty={isDirty || props.saving}
        busy={props.saving}
        status={props.saving ? null : isDirty ? (rebasedVersion !== null
          ? <span className="text-warning">Settings changed to v{rebasedVersion} before your save. Your model changes are kept. Save again to apply them.</span>
          : <span className={HINT}>Unsaved changes</span>) : showSuccess ? <span className="text-success">Model availability saved.</span> : null}
        error={saveFailed ? props.saveError : null}
        submitLabel="Save model availability"
        busyLabel="Saving..."
        onSubmit={() => void handleSave()}
        onCancel={() => { setDraft(buildDraft(settings)); setIsDirty(false); setShowSuccess(false); setSaveFailed(false); setRebasedVersion(null); statusRef.current?.focus(); }}
        statusRef={statusRef}
      />
    </div>
  );
}
