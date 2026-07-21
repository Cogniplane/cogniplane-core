"use client";

import { useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon
} from "lucide-react";

import type { EffortLevel, Model, ModelProvider } from "@cogniplane/shared-types";
import { MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import { AnimatedHeight } from "@/components/ui/animated-height";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";

function effortLabel(effort: EffortLevel): string {
  switch (effort) {
    case "none": return "None";
    case "minimal": return "Minimal";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "X-High";
    case "max": return "Max";
  }
}

function providerLabel(provider: ModelProvider): string {
  return MODEL_PROVIDER_META[provider]?.label ?? provider;
}

// Discrete effort slider, Codex-composer style: a chunky rounded track with a
// dot per supported effort, a brand-filled left segment, and a round white
// thumb. Pointer input snaps to the nearest stop (with capture, so it drags);
// the thumb itself is the keyboard-accessible `role="slider"` element.
function EffortSlider(props: {
  efforts: EffortLevel[];
  value: EffortLevel;
  disabled?: boolean;
  onChange: (effort: EffortLevel) => void;
}) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const lastIndex = props.efforts.length - 1;
  const index = Math.max(0, props.efforts.indexOf(props.value));
  const fraction = lastIndex > 0 ? index / lastIndex : 0;

  const commit = (next: number) => {
    const clamped = Math.min(lastIndex, Math.max(0, next));
    const effort = props.efforts[clamped];
    if (effort && effort !== props.value) props.onChange(effort);
  };

  const stopFromClientX = (clientX: number): number => {
    const rail = railRef.current;
    if (!rail) return index;
    const rect = rail.getBoundingClientRect();
    if (rect.width === 0) return index;
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(f * lastIndex);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (props.disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    commit(stopFromClientX(event.clientX));
    thumbRef.current?.focus();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (props.disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    commit(stopFromClientX(event.clientX));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = index + 1;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = lastIndex;
        break;
      default:
        return;
    }
    event.preventDefault();
    commit(next);
  };

  return (
    <div
      className={cn(
        "relative h-9 touch-none select-none",
        props.disabled ? "opacity-50" : "cursor-pointer"
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    >
      {/* Track */}
      <div className="absolute inset-x-0 top-1/2 h-7 -translate-y-1/2 rounded-full bg-surface-container" />
      {/* Brand fill up to the thumb; the thumb overlaps the seam. */}
      <div
        className="absolute top-1/2 left-0 h-7 -translate-y-1/2 rounded-full bg-brand transition-[width] duration-150 ease-(--ease-standard)"
        style={{ width: `calc(1rem + (100% - 2rem) * ${fraction})` }}
      />
      {/* Rail: the coordinate space for stops and thumb (track minus end caps). */}
      <div ref={railRef} className="absolute inset-x-4 top-0 h-full">
        {props.efforts.map((effort, i) => (
          <span
            key={effort}
            className={cn(
              "absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
              i <= index ? "bg-on-brand/60" : "bg-on-surface-faint/50"
            )}
            style={{ left: `${lastIndex > 0 ? (i / lastIndex) * 100 : 0}%` }}
          />
        ))}
        <div
          ref={thumbRef}
          role="slider"
          aria-label="Reasoning effort"
          aria-valuemin={0}
          aria-valuemax={lastIndex}
          aria-valuenow={index}
          aria-valuetext={effortLabel(props.value)}
          aria-disabled={props.disabled || undefined}
          tabIndex={props.disabled ? -1 : 0}
          onKeyDown={handleKeyDown}
          className="absolute top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 rounded-full border border-outline-variant bg-surface-bright shadow-md outline-none transition-[left] duration-150 ease-(--ease-standard) focus-visible:ring-2 focus-visible:ring-ring dark:bg-primary"
          style={{ left: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}

// Shared row shell for the Advanced menu and drill-in lists.
function MenuRow(props: {
  onSelect: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50",
        props.className
      )}
    >
      {props.children}
    </button>
  );
}

type SelectorView = "slider" | "advanced" | "providers" | "models" | "efforts";

// Codex-composer-style model + effort picker: a single pill trigger
// ("<model> <effort> ⌄") opening a popover whose default view is a discrete
// effort slider under an "Advanced ›" toggle. Advanced mode swaps in classic
// Provider / Model / Effort rows that drill into option lists. Every model
// runs on the Deep Agents runtime, so "Provider" is the LLM provider behind
// each model id (Model.provider), not a runtime choice — the row appears only
// when the (already key-filtered) model list spans more than one provider,
// and picking one auto-selects that provider's default model. The Model
// drill-in lists the selected provider's models. Models that don't support
// reasoning effort (or a tenant with the effort selector off) drop the slider
// and the Effort row; the popover then opens straight on the Advanced menu.
export function ModelEffortSelector(props: {
  model: string;
  effort: EffortLevel | null;
  models: Model[];
  showEffortSelector?: boolean;
  disabled?: boolean;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
}) {
  const selectedModel = props.models.find((model) => model.id === props.model) ?? null;

  const availableEfforts = selectedModel?.supportedEfforts ?? [];
  const effortEnabled =
    Boolean(props.showEffortSelector) && availableEfforts.length > 1 && props.effort !== null;

  // Providers present in the current model list, in first-seen order so the
  // Provider drill-in follows the catalog ordering.
  const providers: ModelProvider[] = [];
  for (const model of props.models) {
    if (!providers.includes(model.provider)) providers.push(model.provider);
  }
  const selectedProvider = selectedModel?.provider ?? providers[0] ?? null;
  const showProviderRow = providers.length > 1;

  // With the Provider row visible, the Model drill-in lists only the selected
  // provider's models; otherwise it lists everything.
  const modelsForProvider =
    !showProviderRow || selectedProvider === null
      ? props.models
      : props.models.filter((model) => model.provider === selectedProvider);

  const rootView: SelectorView = effortEnabled ? "slider" : "advanced";
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SelectorView>(rootView);

  const disabledOrEmpty = props.disabled || props.models.length === 0;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setView(rootView);
  };

  const selectModel = (modelId: string) => {
    if (modelId !== props.model) props.onModelChange(modelId);
    setOpen(false);
  };

  const selectEffort = (effort: EffortLevel) => {
    if (effort !== props.effort) props.onEffortChange(effort);
    setOpen(false);
  };

  // Switching provider selects that provider's default (or first) model so
  // the Model row and the sent model id never disagree. Stay on the Advanced
  // menu: the user likely wants to pick a specific model next.
  const selectProvider = (provider: ModelProvider) => {
    if (provider !== selectedProvider) {
      const candidates = props.models.filter((model) => model.provider === provider);
      const next = candidates.find((model) => model.isDefault) ?? candidates[0];
      if (next) props.onModelChange(next.id);
    }
    setView("advanced");
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabledOrEmpty}
          className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-low px-3.5 py-1.5 text-sm outline-none transition-colors hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="font-medium text-on-surface">
            {selectedModel?.displayName ?? props.model ?? "—"}
          </span>
          {effortEnabled ? (
            <span className="text-on-surface-faint">{effortLabel(props.effort!)}</span>
          ) : null}
          <ChevronDownIcon className="size-3.5 text-on-surface-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(480px,var(--radix-popover-content-available-height))] w-80 overflow-y-auto rounded-xl p-2 shadow-lg"
      >
        <AnimatedHeight durationMs={150}>
          {view === "slider" ? (
            <div className="flex flex-col gap-2">
              <MenuRow onSelect={() => setView("advanced")}>
                <span className="font-medium">Advanced</span>
                <ChevronRightIcon className="size-4 text-on-surface-faint" />
              </MenuRow>
              <div className="px-1.5 pb-1.5">
                <EffortSlider
                  efforts={availableEfforts}
                  value={props.effort!}
                  disabled={props.disabled}
                  onChange={props.onEffortChange}
                />
              </div>
            </div>
          ) : null}

          {view === "advanced" ? (
            <div className="flex flex-col gap-0.5">
              {showProviderRow ? (
                <MenuRow onSelect={() => setView("providers")}>
                  <span className="font-medium">Provider</span>
                  <span className="ml-auto text-on-surface-faint">
                    {selectedProvider ? providerLabel(selectedProvider) : "—"}
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-on-surface-faint" />
                </MenuRow>
              ) : null}
              <MenuRow onSelect={() => setView("models")}>
                <span className="font-medium">Model</span>
                <span className="ml-auto text-on-surface-faint">
                  {selectedModel?.displayName ?? props.model}
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-on-surface-faint" />
              </MenuRow>
              {effortEnabled ? (
                <MenuRow onSelect={() => setView("efforts")}>
                  <span className="font-medium">Effort</span>
                  <span className="ml-auto text-on-surface-faint">
                    {effortLabel(props.effort!)}
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-on-surface-faint" />
                </MenuRow>
              ) : null}
              {effortEnabled ? (
                <>
                  <div className="-mx-1 my-1 h-px bg-border" />
                  <MenuRow onSelect={() => setView("slider")}>
                    <span className="font-medium">Advanced</span>
                    <ChevronUpIcon className="size-4 text-on-surface-faint" />
                  </MenuRow>
                </>
              ) : null}
            </div>
          ) : null}

          {view === "providers" ? (
            <div className="flex flex-col gap-0.5">
              <MenuRow onSelect={() => setView("advanced")}>
                <ChevronLeftIcon className="size-4 text-on-surface-faint" />
                <span className="font-medium">Provider</span>
              </MenuRow>
              <div className="-mx-1 my-1 h-px bg-border" />
              {providers.map((provider) => (
                <MenuRow key={provider} onSelect={() => selectProvider(provider)}>
                  <span className={provider === selectedProvider ? "font-semibold" : undefined}>
                    {providerLabel(provider)}
                  </span>
                  {provider === selectedProvider ? (
                    <CheckIcon className="ml-auto size-4 shrink-0 text-brand" />
                  ) : null}
                </MenuRow>
              ))}
            </div>
          ) : null}

          {view === "models" ? (
            <div className="flex flex-col gap-0.5">
              <MenuRow onSelect={() => setView("advanced")}>
                <ChevronLeftIcon className="size-4 text-on-surface-faint" />
                <span className="font-medium">Model</span>
              </MenuRow>
              <div className="-mx-1 my-1 h-px bg-border" />
              {modelsForProvider.map((model) => (
                <MenuRow key={model.id} onSelect={() => selectModel(model.id)}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={model.id === props.model ? "font-semibold" : "font-medium"}>
                      {model.displayName}
                    </span>
                    {model.description ? (
                      <span className="text-xs text-muted-foreground">{model.description}</span>
                    ) : null}
                  </span>
                  {model.id === props.model ? (
                    <CheckIcon className="size-4 shrink-0 text-brand" />
                  ) : null}
                </MenuRow>
              ))}
            </div>
          ) : null}

          {view === "efforts" ? (
            <div className="flex flex-col gap-0.5">
              <MenuRow onSelect={() => setView("advanced")}>
                <ChevronLeftIcon className="size-4 text-on-surface-faint" />
                <span className="font-medium">Effort</span>
              </MenuRow>
              <div className="-mx-1 my-1 h-px bg-border" />
              {availableEfforts.map((effort) => (
                <MenuRow key={effort} onSelect={() => selectEffort(effort)}>
                  <span className={effort === props.effort ? "font-semibold" : undefined}>
                    {effortLabel(effort)}
                  </span>
                  {effort === props.effort ? (
                    <CheckIcon className="ml-auto size-4 shrink-0 text-brand" />
                  ) : null}
                </MenuRow>
              ))}
            </div>
          ) : null}
        </AnimatedHeight>
      </PopoverContent>
    </Popover>
  );
}
