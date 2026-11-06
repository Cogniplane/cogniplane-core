"use client";

import { useId, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import type { EffortLevel, Model } from "@cogniplane/shared-types";
import { MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import { cn } from "@/lib/cn";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Readable names of the effort levels. The value that the agent sends stays
 *  the enum value. */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};

/** The model and reasoning effort for the next message.
 *
 *  The trigger never grows past its row: a long model name is cut with an
 *  ellipsis, and the effort and the chevron keep their place. The full name
 *  is in the accessible name, in the tooltip, and in the open list, where
 *  names wrap. Models and efforts are pressed buttons in named groups. */
export function ModelEffortSelector(props: {
  model: string;
  effort: EffortLevel | null;
  models: Model[];
  showEffortSelector?: boolean;
  disabled?: boolean;
  /** Placement classes of the trigger in its toolbar. */
  className?: string;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchId = useId();
  const effortLabelId = useId();
  const selected = props.models.find((model) => model.id === props.model);
  const providers = [...new Set(props.models.map((model) => model.provider))];
  const filtered = props.models.filter((model) =>
    `${model.displayName} ${MODEL_PROVIDER_META[model.provider].label}`
      .toLowerCase().includes(search.trim().toLowerCase())
  );
  const showEffort = Boolean(props.showEffortSelector && selected && selected.supportedEfforts.length > 1 && props.effort);
  const modelName = selected?.displayName ?? props.model;
  const effortLabel = showEffort && props.effort ? EFFORT_LABELS[props.effort] : null;
  const triggerName = `Model: ${modelName}${effortLabel ? `. Reasoning effort: ${effortLabel}` : ""}`;

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerName}
          title={triggerName}
          disabled={props.disabled || props.models.length === 0}
          className={cn(
            "inline-flex h-8 min-w-0 max-w-[22rem] items-center gap-1.5 rounded-md border border-input bg-control px-3 text-sm outline-none transition-[color,box-shadow] duration-150 hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 motion-reduce:transition-none",
            props.className
          )}
        >
          <span className="min-w-0 truncate font-medium text-on-surface">{modelName}</span>
          {effortLabel ? <span className="shrink-0 text-on-surface-variant">{effortLabel}</span> : null}
          <ChevronDownIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-on-surface-variant" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-lg p-3">
        <label htmlFor={searchId} className="mb-1 block px-2 text-sm font-semibold text-on-surface">Choose a model</label>
        <Input id={searchId} type="search" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models" className="mb-3" />
        {providers.map((provider) => {
          const models = filtered.filter((model) => model.provider === provider);
          if (models.length === 0) return null;
          const groupId = `${searchId}-${provider}`;
          return <div key={provider} role="group" aria-labelledby={groupId} className="mb-3">
            <p id={groupId} className="px-2 py-1 text-xs font-semibold text-on-surface-variant">{MODEL_PROVIDER_META[provider].label}</p>
            {models.map((model) => <button key={model.id} type="button" aria-pressed={model.id === props.model} onClick={() => { if (model.id !== props.model) props.onModelChange(model.id); setOpen(false); }} className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:font-medium">
              <span className="min-w-0 flex-1 break-words">{model.displayName}</span>
              {model.id === props.model ? <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" /> : null}
            </button>)}
          </div>;
        })}
        {filtered.length === 0 ? <p className="px-2 py-3 text-sm text-on-surface-variant">No models match.</p> : null}
        {showEffort ? <div className="border-t border-outline-variant px-2 pt-3">
          <p id={effortLabelId} className="mb-2 text-xs font-semibold text-on-surface-variant">Reasoning effort</p>
          <div role="group" aria-labelledby={effortLabelId} className="flex flex-wrap gap-1.5">
            {selected!.supportedEfforts.map((effort) => <button key={effort} type="button" onClick={() => { props.onEffortChange(effort); setOpen(false); }} aria-pressed={effort === props.effort} className="h-8 rounded-md border border-input bg-control px-2.5 text-xs font-medium text-on-surface outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:border-brand-border aria-pressed:bg-brand-surface aria-pressed:text-brand-strong">{EFFORT_LABELS[effort]}</button>)}
          </div>
        </div> : null}
      </PopoverContent>
    </Popover>
  );
}
