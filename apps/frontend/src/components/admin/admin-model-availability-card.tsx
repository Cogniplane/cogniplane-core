"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  AdminModelCatalogResponse,
  AdminProviderStatus,
  CustomModelCreateRequest,
  EffortLevel,
  Model,
  ModelProvider,
  OpenRouterModelOption,
  TenantSettings
} from "@cogniplane/shared-types";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { CHIP, HINT, PILL_AMBER, PILL_BLUE, PILL_GRAY, PILL_GREEN, SECTION_LABEL } from "../../lib/ui-tokens";

export type ModelAvailabilityInput = {
  enabledProviders: ModelProvider[];
  enabledModelIds: string[] | null;
  modelDefaultEfforts: Record<string, EffortLevel>;
};

type Draft = {
  enabledProviders: ModelProvider[];
  // "all" keeps enabledModelIds null server-side; "custom" persists the list.
  modelSelectionMode: "all" | "custom";
  enabledModelIds: string[];
  modelDefaultEfforts: Record<string, EffortLevel>;
};

function buildDraft(settings: TenantSettings): Draft {
  return {
    enabledProviders: settings.enabledProviders,
    modelSelectionMode: settings.enabledModelIds === null ? "all" : "custom",
    enabledModelIds: settings.enabledModelIds ?? [],
    modelDefaultEfforts: { ...settings.modelDefaultEfforts }
  };
}

function keySourcePill(status: AdminProviderStatus) {
  switch (status.keySource) {
    case "tenant":
      return <span className={PILL_GREEN}>organization key</span>;
    case "platform":
      return <span className={PILL_BLUE}>platform key</span>;
    default:
      return <span className={PILL_GRAY}>no key</span>;
  }
}

function ProviderRow(props: {
  status: AdminProviderStatus;
  enabled: boolean;
  modelCount: number;
  onToggle: (enabled: boolean) => void;
}) {
  const { status, enabled } = props;
  return (
    <label className="flex flex-wrap items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => props.onToggle(e.target.checked)}
        className="size-4 rounded border-outline-variant accent-primary"
      />
      <span className="min-w-28 text-sm font-semibold text-on-surface">{status.label}</span>
      {keySourcePill(status)}
      {enabled && status.keySource === "none" ? (
        <span className={PILL_AMBER}>models hidden until a key is configured</span>
      ) : null}
      {!enabled ? (
        <span className="text-xs text-on-surface-faint">disabled — models hidden even with a key</span>
      ) : null}
      <span className="ml-auto text-xs text-on-surface-faint">
        {props.modelCount} model{props.modelCount === 1 ? "" : "s"}
      </span>
    </label>
  );
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
      <SelectTrigger size="sm" className="h-7 w-32 text-xs">
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
  onSave: (input: ModelAvailabilityInput) => Promise<boolean>;
  adding: boolean;
  addError: string | null;
  openRouterModels: OpenRouterModelOption[] | null;
  openRouterLoadError: string | null;
  onNeedOpenRouterModels: () => void;
  onAddModel: (input: CustomModelCreateRequest) => Promise<boolean>;
  onRemoveModel: (modelId: string) => Promise<boolean>;
}) {
  const { catalog, settings } = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

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
    setDraft((current) => (current ? recipe(current) : current));
  }

  const toggleProvider = (provider: ModelProvider, enabled: boolean) =>
    updateDraft((current) => ({
      ...current,
      enabledProviders: enabled
        ? [...current.enabledProviders, provider]
        : current.enabledProviders.filter((p) => p !== provider)
    }));

  const toggleModel = (modelId: string, enabled: boolean) =>
    updateDraft((current) => ({
      ...current,
      enabledModelIds: enabled
        ? [...current.enabledModelIds, modelId]
        : current.enabledModelIds.filter((id) => id !== modelId)
    }));

  const handleRemoveModel = async (modelId: string) => {
    const removed = await props.onRemoveModel(modelId);
    if (!removed) return;
    // The backend scrubbed the deleted model from tenant_settings, but the
    // resync effect deliberately ignores server state while the draft is
    // dirty — strip the id locally so a later Save can't submit a reference
    // to the deleted model (the PUT rejects unknown ids with a 400). Plain
    // setDraft, NOT updateDraft: removal alone must not mark a clean draft
    // dirty (server state already matches).
    setDraft((current) => {
      if (!current) return current;
      const { [modelId]: _removed, ...remainingEfforts } = current.modelDefaultEfforts;
      return {
        ...current,
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

  const handleSave = async () => {
    const saved = await props.onSave({
      enabledProviders: draft.enabledProviders,
      enabledModelIds: draft.modelSelectionMode === "all" ? null : draft.enabledModelIds,
      modelDefaultEfforts: draft.modelDefaultEfforts
    });
    if (saved) {
      setIsDirty(false);
      setShowSuccess(true);
    }
  };

  return (
    <Card>
      <CardHeader>
        <p className={SECTION_LABEL}>Model Availability</p>
        <h2 className="text-lg font-semibold text-on-surface">Providers &amp; Models</h2>
        <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
          Choose which providers and models members can use, and the default reasoning effort per
          model. A model is selectable only when its provider is enabled here and has an API key.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <p className={SECTION_LABEL}>Providers</p>
          {catalog.providers.map((status) => (
            <ProviderRow
              key={status.id}
              status={status}
              enabled={draft.enabledProviders.includes(status.id)}
              modelCount={modelsByProvider.get(status.id)?.length ?? 0}
              onToggle={(enabled) => toggleProvider(status.id, enabled)}
            />
          ))}
        </section>

        <section className="flex flex-col gap-3">
          <div>
            <p className={SECTION_LABEL}>Models</p>
            <div className="mt-2 flex flex-col gap-1.5">
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
                    {!providerEnabled ? <span className={PILL_GRAY}>provider disabled</span> : null}
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
                            <EffortSelect
                              model={model}
                              value={draft.modelDefaultEfforts[model.id] ?? null}
                              disabled={!providerEnabled || !checked}
                              onChange={(effort) => setModelEffort(model, effort)}
                            />
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

          <AddCustomModelForm
            adding={props.adding}
            addError={props.addError}
            openRouterModels={props.openRouterModels}
            openRouterLoadError={props.openRouterLoadError}
            onNeedOpenRouterModels={props.onNeedOpenRouterModels}
            onAdd={props.onAddModel}
          />
        </section>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={handleSave} disabled={props.saving || !isDirty}>
            {props.saving ? "Saving..." : "Save model availability"}
          </Button>
          {showSuccess ? (
            <span className="text-sm text-success">Model availability saved.</span>
          ) : null}
          {isDirty && !props.saving ? <span className={HINT}>Unsaved changes</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
