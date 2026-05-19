"use client";

import { ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";

import type { EffortLevel, Model, RuntimeProvider } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

function providerLabel(provider: RuntimeProvider): string {
  return provider === "claude-code" ? "Claude" : "Codex";
}

function providerDescription(provider: RuntimeProvider): string {
  return provider === "claude-code" ? "Anthropic Claude models" : "OpenAI Codex models";
}

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

function SelectorTrigger(props: {
  caption: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={props.disabled}
      className="gap-2"
    >
      <span className="text-[0.62rem] font-bold uppercase tracking-[0.05em] text-on-surface-faint">
        {props.caption}
      </span>
      <span className="text-xs font-medium">{props.label}</span>
      <ChevronDownIcon className="size-3 opacity-60" />
    </Button>
  );
}

export function ProviderModelSelector(props: {
  provider: RuntimeProvider;
  enabledProviders: RuntimeProvider[];
  model: string;
  effort: EffortLevel | null;
  models: Model[];
  showEffortSelector?: boolean;
  disabled?: boolean;
  onProviderChange: (provider: RuntimeProvider) => void;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
}) {
  const providerModels = useMemo(
    () => props.models.filter((model) => model.provider === props.provider),
    [props.models, props.provider]
  );

  const selectedModel = providerModels.find((model) => model.id === props.model)
    ?? props.models.find((model) => model.id === props.model)
    ?? null;
  const showProviderSelector = props.enabledProviders.length > 1;
  const availableEfforts = selectedModel?.supportedEfforts ?? [];
  const shouldShowEffortSelector =
    Boolean(props.showEffortSelector) && availableEfforts.length > 1 && props.effort !== null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showProviderSelector ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <span>
              <SelectorTrigger
                caption="Provider"
                label={providerLabel(props.provider)}
                disabled={props.disabled}
              />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[220px]">
            {props.enabledProviders.map((provider) => (
              <DropdownMenuItem
                key={provider}
                onSelect={() => props.onProviderChange(provider)}
                className="flex flex-col items-start gap-0.5"
              >
                <span className={provider === props.provider ? "font-semibold" : "font-medium"}>
                  {providerLabel(provider)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {providerDescription(provider)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <span>
            <SelectorTrigger
              caption="Model"
              label={selectedModel?.displayName ?? props.model}
              disabled={props.disabled || providerModels.length === 0}
            />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[280px]">
          {providerModels.map((model) => (
            <DropdownMenuItem
              key={model.id}
              onSelect={() => props.onModelChange(model.id)}
              className="flex flex-col items-start gap-0.5"
            >
              <span className={model.id === props.model ? "font-semibold" : "font-medium"}>
                {model.displayName}
              </span>
              {model.description ? (
                <span className="text-xs text-muted-foreground">{model.description}</span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {shouldShowEffortSelector ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <span>
              <SelectorTrigger
                caption="Effort"
                label={effortLabel(props.effort!)}
                disabled={props.disabled}
              />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[140px]">
            {availableEfforts.map((effort) => (
              <DropdownMenuItem
                key={effort}
                onSelect={() => props.onEffortChange(effort)}
                className={effort === props.effort ? "font-semibold" : undefined}
              >
                {effortLabel(effort)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
