"use client";

import { useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import type { EffortLevel, Model } from "@cogniplane/shared-types";
import { MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ModelEffortSelector(props: {
  model: string;
  effort: EffortLevel | null;
  models: Model[];
  showEffortSelector?: boolean;
  disabled?: boolean;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = props.models.find((model) => model.id === props.model);
  const providers = [...new Set(props.models.map((model) => model.provider))];
  const filtered = props.models.filter((model) =>
    `${model.displayName} ${MODEL_PROVIDER_META[model.provider].label}`
      .toLowerCase().includes(search.trim().toLowerCase())
  );
  const showEffort = Boolean(props.showEffortSelector && selected && selected.supportedEfforts.length > 1 && props.effort);

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button type="button" disabled={props.disabled || props.models.length === 0} className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-low px-3.5 py-1.5 text-sm outline-none hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <span className="font-medium text-on-surface">{selected?.displayName ?? props.model}</span>
          {showEffort ? <span className="text-on-surface-faint">{props.effort}</span> : null}
          <ChevronDownIcon className="size-3.5 text-on-surface-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(480px,var(--radix-popover-content-available-height))] w-80 overflow-y-auto rounded-xl p-3 shadow-lg">
        <label htmlFor="chat-model-search" className="mb-1 block text-xs font-semibold text-on-surface-variant">Choose a model</label>
        <input id="chat-model-search" type="search" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models" className="mb-3 w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        {providers.map((provider) => {
          const models = filtered.filter((model) => model.provider === provider);
          if (models.length === 0) return null;
          return <div key={provider} className="mb-3">
            <p className="px-2 py-1 text-xs font-semibold text-on-surface-faint">{MODEL_PROVIDER_META[provider].label}</p>
            {models.map((model) => <button key={model.id} type="button" aria-pressed={model.id === props.model} onClick={() => { if (model.id !== props.model) props.onModelChange(model.id); setOpen(false); }} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
              <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
              {model.id === props.model ? <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-brand" /> : null}
            </button>)}
          </div>;
        })}
        {filtered.length === 0 ? <p className="px-2 py-3 text-sm text-on-surface-variant">No models match.</p> : null}
        {showEffort ? <details className="border-t border-outline-variant pt-2">
          <summary className="cursor-pointer px-2 py-1 text-sm font-medium">Reasoning effort: {props.effort}</summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {selected!.supportedEfforts.map((effort) => <button key={effort} type="button" onClick={() => { props.onEffortChange(effort); setOpen(false); }} aria-pressed={effort === props.effort} className="rounded-md border border-outline-variant px-2 py-1 text-xs hover:bg-accent aria-pressed:bg-brand aria-pressed:text-on-brand">{effort}</button>)}
          </div>
        </details> : null}
      </PopoverContent>
    </Popover>
  );
}
