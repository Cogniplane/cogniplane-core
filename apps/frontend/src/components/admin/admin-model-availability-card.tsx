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
import { useFeedbackFocus } from "./use-feedback-focus";

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
export type ModelAvailabilitySaveResult = boolean | { conflict: TenantSettings } | { saved: TenantSettings };

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

function focusFeedback(target: HTMLElement | null) {
  if (!target) return;
  target.focus();
  const box = target.getBoundingClientRect();
  if (box.top < 4 || box.bottom > window.innerHeight - 4) target.scrollIntoView?.({ block: "center", inline: "nearest" });
}

function trackOperationFocus(trigger: HTMLElement | null, pendingTarget?: HTMLElement | null): () => boolean {
  let owns = document.activeElement === trigger;
  const target = owns && pendingTarget ? pendingTarget : trigger;
  if (owns && pendingTarget) focusFeedback(pendingTarget);
  const moved = (event: FocusEvent) => { if (event.target !== target) owns = false; };
  document.addEventListener("focusin", moved);
  return () => {
    document.removeEventListener("focusin", moved);
    return owns && (document.activeElement === target || document.activeElement === document.body);
  };
}

const ROW = "flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between";

/**
 * "Add custom model" form. OpenRouter gets a type-ahead over the server-
 * proxied public catalog (slug + metadata auto-fill happen backend-side);
 * other providers take manual metadata since no key-free lookup exists.
 */
function AddCustomModelForm(props: {
  adding: boolean;
  blocked: boolean;
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
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const pickerInput = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const [result, setResult] = useState<string | null>(null);
  const focusResult = useFeedbackFocus();

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
    vendorModelId.trim().length > 0 && vendorModelId.trim().length <= 150 &&
    !/\s|\.\.|\\/.test(vendorModelId.trim()) &&
    (!needsManualMetadata || (displayName.trim().length > 0 && displayName.trim().length <= 120 &&
      Number.isInteger(Number(contextWindow)) && Number(contextWindow) >= 1000 && Number(contextWindow) <= 100000000));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting.current || props.blocked) return;
    submitting.current = true;
    setPending(true);
    const modelName = displayName.trim() || vendorModelId.trim();
    setResult(`Adding ${modelName}...`);
    const ownsFocus = trackOperationFocus(document.activeElement as HTMLElement | null, resultRef.current);
    try {
      const added = await props.onAdd({
        provider,
        vendorModelId: vendorModelId.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(needsManualMetadata && Number(contextWindow) > 0
          ? { contextWindow: Number(contextWindow) }
          : {})
      });
      if (added) {
        setResult(`${modelName} added. Choose its availability in the draft, then save model availability.`);
        setVendorModelId("");
        setDisplayName("");
        setContextWindow("");
      } else setResult(`${modelName} was not added. Your input is kept. Review the error and try again.`);
    } finally {
      submitting.current = false;
      setPending(false);
      if (ownsFocus()) focusResult(() => resultRef.current);
    }
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={handleSubmit}
    >
      <div>
        <p className="text-sm font-semibold text-on-surface">Add a model</p>
        <p className="mt-0.5 text-xs text-on-surface-faint">
          {provider === "openrouter"
            ? "Search by slug or name. Adding a model validates its metadata through the OpenRouter catalog."
            : `Add any ${MODEL_PROVIDER_META[provider].label} model id. Display name and context window are required.`}
        </p>
      </div>

      <fieldset disabled={pending || props.blocked} className="flex min-w-0 flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="custom-model-provider">Provider</Label>
          <Select
            value={provider}
            onValueChange={(next) => {
              setProvider(next as ModelProvider);
              setPickerOpen(false);
              setResult(null);
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

        <div className="relative flex min-w-0 basis-64 flex-1 flex-col gap-1.5"
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPickerOpen(false); }}
          onKeyDown={(event) => { if (event.key === "Escape") { pickerInput.current?.focus(); setPickerOpen(false); } }}>
          <Label htmlFor="custom-model-id">
            {provider === "openrouter" ? "OpenRouter slug" : "Vendor model id"}
          </Label>
          <Input
            id="custom-model-id"
            ref={pickerInput}
            maxLength={150}
            aria-describedby="custom-model-picker-status"
            aria-controls={provider === "openrouter" && pickerOpen && suggestions.length > 0 ? "custom-model-suggestions" : undefined}
            autoComplete="off"
            value={vendorModelId}
            placeholder={provider === "openrouter" ? "moonshotai/kimi-k3" : "model-id"}
            onChange={(e) => {
              setVendorModelId(e.target.value);
              setPickerOpen(true);
              setResult(null);
            }}
            onFocus={() => setPickerOpen(true)}
          />
          {pickerOpen && suggestions.length > 0 ? (
            <ul id="custom-model-suggestions" aria-label="OpenRouter suggestions" className="absolute top-full z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-outline-variant bg-surface-container-high p-1 shadow-md">
              {suggestions.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 flex-col items-start rounded-sm px-3 py-2 text-left break-words hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => {
                      setVendorModelId(option.id);
                      pickerInput.current?.focus();
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
                maxLength={120}
                autoComplete="off"
                className="w-44"
                value={displayName}
                placeholder="GPT-6 Preview"
                onChange={(e) => { setDisplayName(e.target.value); setResult(null); }}
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
                max={100000000}
                step={1}
                value={contextWindow}
                placeholder="400000"
                onChange={(e) => { setContextWindow(e.target.value); setResult(null); }}
              />
            </div>
          </>
        ) : null}

        <Button type="submit" disabled={props.adding || !canSubmit}>
          {pending || props.adding ? "Adding model..." : "Add model"}
        </Button>
      </fieldset>
      <p ref={resultRef} role="status" tabIndex={-1} className="rounded-sm text-sm text-on-surface-variant outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {result ?? "Adding a model saves it immediately. Use the availability draft to choose whether members can select it."}
      </p>
      <p id="custom-model-picker-status" role="status" className="text-sm text-on-surface-variant">
        {provider !== "openrouter" ? "Context window must be a whole number from 1,000 to 100,000,000 tokens."
          : props.openRouterLoadError ? `${props.openRouterLoadError} Adding a model still requires server catalog validation. Try again when the catalog is available.`
          : !props.openRouterModels ? "Loading OpenRouter suggestions..."
          : vendorModelId.trim().length < 2 ? "Type at least two characters for suggestions. You can also enter an exact slug."
          : suggestions.length === 0 ? "No matching suggestions. Check the exact slug before adding."
          : "Use Tab to reach a suggestion, then Enter to choose it."}
      </p>
      {props.addError ? <p role="alert" className="text-sm text-danger">{props.addError}</p> : null}
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
  writesBlocked?: boolean;
  recoveredVersion?: number | null;
  readError?: string | null;
  retryingRead?: boolean;
  onRetryRead?: () => Promise<void>;
}) {
  const { catalog, settings } = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [customModelOpen, setCustomModelOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const operationStatusRef = useRef<HTMLDivElement>(null);
  const removalStatusRef = useRef<HTMLParagraphElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const revision = useRef(0);
  const savingRef = useRef(false);
  const [savingLocal, setSavingLocal] = useState(false);
  const removingRef = useRef(false);
  const [removing, setRemoving] = useState(false);
  const [removeDecision, setRemoveDecision] = useState<Model | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  // The page keeps the last mutation error. Show it only for this draft's last save.
  const [saveFailed, setSaveFailed] = useState(false);
  // The newer version that the draft moved to after a save conflict.
  const [rebasedVersion, setRebasedVersion] = useState<number | null>(null);
  const focusResult = useFeedbackFocus();
  useConfirmLeave(isDirty);

  // Seed/resync the draft from the server state unless the admin has local
  // edits in flight.
  useEffect(() => {
    if (settings && !isDirty) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(buildDraft(settings));
    }
  }, [settings, isDirty]);

  useEffect(() => {
    if (props.recoveredVersion == null) return;
    // An explicit read recovered after a failed conflict refresh.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(current => current ? { ...current, expectedVersion: props.recoveredVersion! } : current);
    setRebasedVersion(props.recoveredVersion);
  }, [props.recoveredVersion]);

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

  const busy = savingLocal || props.saving;
  const blocked = Boolean(props.writesBlocked || busy || props.adding || removing);

  function updateDraft(recipe: (current: Draft) => Draft): void {
    revision.current += 1;
    setIsDirty(true);
    setShowSuccess(false);
    setOperationMessage(null);
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

  const handleRemoveModel = async (model: Model, trigger: HTMLButtonElement) => {
    if (removingRef.current || blocked) return;
    removingRef.current = true;
    setRemoving(true);
    setRemoveError(null);
    const ownsFocus = trackOperationFocus(trigger, removalStatusRef.current);
    let removed = false;
    try {
      const modelId = model.id;
      const updated = await props.onRemoveModel(modelId);
      if (!updated) { setRemoveError(`Could not remove ${model.displayName}. Your availability draft is kept. Try again.`); return; }
      // The backend removed the model from tenant_settings. The resync effect
      // ignores server state while the draft is dirty, so strip the id here.
      // Otherwise the next Save sends an unknown id and gets a 400. Use
      // setDraft, not updateDraft, so a clean draft stays clean. Expect the new
      // settings version on the next Save.
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
      removed = true;
      setRemoveDecision(null);
      setOperationMessage(`${model.displayName} removed. Your other availability edits are kept.`);
    } finally {
      removingRef.current = false;
      setRemoving(false);
      if (ownsFocus()) {
        if (removed) focusResult(() => operationStatusRef.current);
        else if (removalStatusRef.current) focusResult(() => removalStatusRef.current);
        else requestAnimationFrame(() => { if (document.activeElement === document.body) trigger.focus(); });
      }
    }
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
    if (savingRef.current || blocked) return;
    savingRef.current = true;
    setSavingLocal(true);
    const sentRevision = revision.current;
    const ownsFocus = trackOperationFocus(saveRef.current, statusRef.current);
    try {
      const saved = await props.onSave({
        expectedVersion: draft.expectedVersion,
        enabledProviders: draft.enabledProviders,
        enabledModelIds: draft.modelSelectionMode === "all" ? null : draft.enabledModelIds,
        defaultModelId: draft.defaultModelId,
        modelDefaultEfforts: draft.modelDefaultEfforts,
        showEffortSelector: draft.showEffortSelector
      });
      if (typeof saved === "object" && "conflict" in saved) {
        // This page saves only the fields in the draft. So keep them all and move
        // the draft to the newer version. The administrator saves again.
        setDraft((current) => (current ? { ...current, expectedVersion: saved.conflict.version } : current));
        setRebasedVersion(saved.conflict.version);
        setSaveFailed(false);
        return;
      }
      setSaveFailed(!saved);
      if (saved) {
        const changedDuringSave = revision.current !== sentRevision;
        if (typeof saved === "object" && "saved" in saved) {
          setDraft(current => current ? { ...current, expectedVersion: saved.saved.version } : current);
        }
        setIsDirty(changedDuringSave);
        setShowSuccess(!changedDuringSave);
        setOperationMessage(changedDuringSave ? "Submitted availability saved. Your later edits are still unsaved." : null);
        setRebasedVersion(null);
      }
    } finally {
      savingRef.current = false;
      setSavingLocal(false);
      if (ownsFocus()) focusResult(() => statusRef.current);
    }
  };

  return (
    <div>
    <section aria-labelledby="models-heading">
      <h2 id="models-heading" className="text-lg font-semibold text-on-surface">Model settings</h2>
      <p className="mt-1 text-sm text-on-surface-variant">Default, availability, provider Use choices, and effort are a draft until you save model availability.</p>
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
          <select id="organization-default-model" aria-labelledby="default-model-heading" className="h-9 w-full min-w-0 rounded-md border border-input bg-control px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring sm:w-64 sm:shrink-0" value={draft.defaultModelId ?? ""} onChange={(event) => updateDraft((current) => ({ ...current, defaultModelId: event.target.value || null }))}>
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
                  <span className="text-xs text-on-surface-variant">
                    Newly released models become available automatically.
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
              No models selected. Members will have nothing to pick in the model selector.
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
                            <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium break-words text-on-surface [overflow-wrap:anywhere]">
                              {model.displayName}
                              {model.source === "custom" ? (
                                <span className={CHIP}>custom</span>
                              ) : null}
                            </span>
                            <span className="block text-xs break-words text-on-surface-variant [overflow-wrap:anywhere]">
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
                                aria-label={`Remove ${model.displayName}`}
                                disabled={blocked}
                                onClick={() => { setRemoveDecision(model); setRemoveError(null); }}
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

          {removeDecision ? <div className="flex min-w-0 flex-col gap-3 border-t border-outline-variant pt-4" aria-label={`Remove ${removeDecision.displayName}`}>
            <h4 className="font-medium break-words [overflow-wrap:anywhere]">Remove {removeDecision.displayName}?</h4>
            <p className="text-sm text-on-surface-variant">This removes the custom model immediately, including its saved default and effort references. Other unsaved availability edits stay in your draft.</p>
            {settings.defaultModelId === removeDecision.id ? <p className="text-sm text-warning">This is the saved default. New chats will use the next available default.</p> : null}
            {settings.enabledModelIds?.length === 1 && settings.enabledModelIds[0] === removeDecision.id ? <p className="text-sm text-warning">This is the last saved selected model. Removing it restores all remaining models in the saved availability settings. Your current draft still needs its own save.</p> : null}
            <p ref={removalStatusRef} role="status" tabIndex={-1} className="rounded-sm text-sm text-on-surface-variant outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{removing ? `Removing ${removeDecision.displayName}...` : removeError ? "Model removal was not confirmed. Review the error below." : "Confirm model removal to save this change."}</p>
            <div className="flex flex-wrap gap-2"><Button type="button" variant="destructive" disabled={blocked} onClick={event => void handleRemoveModel(removeDecision, event.currentTarget)}>{removing ? "Removing model..." : "Confirm model removal"}</Button><Button type="button" variant="outline" disabled={removing} onClick={() => { setRemoveDecision(null); setRemoveError(null); }}>Keep model</Button></div>
            {removeError ? <p role="alert" className="text-sm text-danger">{removeError}</p> : null}
          </div> : null}
          </section>
        </DisclosureRow>
        <DisclosureRow title="Reasoning effort" action="Edit effort" status={draft.showEffortSelector ? "Members can choose the effort in the chat picker." : "Chats use each model's default effort."}>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.showEffortSelector} onChange={(event) => updateDraft((current) => ({ ...current, showEffortSelector: event.target.checked }))} /> Show reasoning effort in the chat picker</label>
          {catalog.models.filter((model) => model.supportedEfforts.length > 1).map((model) => <div key={model.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="min-w-0 break-words [overflow-wrap:anywhere]">{model.displayName}</span><EffortSelect model={model} value={draft.modelDefaultEfforts[model.id] ?? null} disabled={false} onChange={(effort) => setModelEffort(model, effort)} /></div>)}
        </DisclosureRow>
        <DisclosureRow title="Custom models" action="Add model" status={customCount ? `${customCount} custom model${customCount === 1 ? "" : "s"}. Add and remove save immediately.` : "No custom models. Adding saves immediately."} disabled={props.adding} onOpenChange={setCustomModelOpen}>
          {customModelOpen ? <AddCustomModelForm
            adding={props.adding}
            blocked={blocked}
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
      <p className="mt-1 text-sm text-on-surface-variant">Organization key changes save immediately. Use choices apply when you save model availability.</p>
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

      <div ref={operationStatusRef} role={operationMessage ? "status" : undefined} tabIndex={-1} className="mt-3 rounded-sm text-sm text-on-surface-variant focus-visible:ring-2 focus-visible:ring-ring">{operationMessage}</div>
      <SaveBar
        dirty={isDirty || busy}
        keepFeedbackVisible={showSuccess}
        busy={blocked}
        submitRef={saveRef}
        status={props.readError ? <><span className="text-danger">{props.readError}</span>{props.onRetryRead ? <Button type="button" variant="outline" aria-disabled={props.retryingRead || undefined} onClick={async event => {
          if (props.retryingRead) return;
          const ownsFocus = trackOperationFocus(event.currentTarget, statusRef.current);
          try { await props.onRetryRead?.(); }
          finally { if (ownsFocus()) focusResult(() => statusRef.current); }
        }}>{props.retryingRead ? "Loading model settings..." : "Retry model data"}</Button> : null}</> : busy ? <span>Saving submitted availability. Later edits stay in your draft.</span> : isDirty ? (rebasedVersion !== null
          ? <span className="text-warning">Settings changed to v{rebasedVersion} before your save. Your model changes are kept. Save again to apply them.</span>
          : <span className={HINT}>Unsaved changes</span>) : showSuccess ? <span className="text-success">Model availability saved.</span> : null}
        error={saveFailed ? props.saveError : null}
        submitLabel="Save model availability"
        busyLabel={busy ? "Saving availability..." : "Save model availability"}
        onSubmit={() => void handleSave()}
        onCancel={() => { if (blocked) return; revision.current += 1; setDraft(buildDraft(settings)); setIsDirty(false); setShowSuccess(false); setOperationMessage(null); setSaveFailed(false); setRebasedVersion(null); statusRef.current?.focus(); }}
        statusRef={statusRef}
      />
    </div>
  );
}
