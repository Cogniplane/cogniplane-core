"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { fetchModels } from "../lib/api-client";
import type { EffortLevel, Model, RuntimeProvider } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

type Props = {
  skillId: string;
  skillName: string;
  isBusy: boolean;
  submitError?: string | null;
  onCancel: () => void;
  onSubmit: (input: {
    sessionCount: number;
    provider: RuntimeProvider;
    model: string;
    effort: EffortLevel | null;
  }) => Promise<void>;
};

const DEFAULT_SESSION_COUNT = 50;
const MAX_SESSION_COUNT = 200;

const PROVIDER_LABELS: Record<RuntimeProvider, string> = {
  codex: "Codex (OpenAI)",
  "claude-code": "Claude Code (Anthropic)"
};

export function AdminSkillImproveModal({
  skillId,
  skillName,
  isBusy,
  submitError,
  onCancel,
  onSubmit
}: Props) {
  const [sessionCountInput, setSessionCountInput] = useState<string>(String(DEFAULT_SESSION_COUNT));
  const [allModels, setAllModels] = useState<Model[]>([]);
  const [enabledProviders, setEnabledProviders] = useState<RuntimeProvider[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<RuntimeProvider | null>(null);
  const [showEffortSelector, setShowEffortSelector] = useState(true);
  const [provider, setProvider] = useState<RuntimeProvider | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    fetchModels()
      .then(({ models, enabledRuntimeProviders, defaultRuntimeProvider, showEffortSelector: nextShowEffort }) => {
        if (cancelled) return;
        setAllModels(models);
        setEnabledProviders(enabledRuntimeProviders);
        setDefaultProvider(defaultRuntimeProvider);
        setShowEffortSelector(nextShowEffort);
        const initialProvider = enabledRuntimeProviders.includes(defaultRuntimeProvider)
          ? defaultRuntimeProvider
          : enabledRuntimeProviders[0] ?? null;
        setProvider(initialProvider);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const providerModels = useMemo(
    () => (provider ? allModels.filter((m) => m.provider === provider) : []),
    [allModels, provider]
  );

  useEffect(() => {
    if (providerModels.length === 0) {
      // Auto-correct selection when parent data changes; user can still override.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModel(null);
      return;
    }
    if (model && providerModels.some((m) => m.id === model)) return;
    const next = providerModels.find((m) => m.isDefault) ?? providerModels[0];
    setModel(next.id);
  }, [providerModels, model]);

  const selectedModel = useMemo(
    () => providerModels.find((m) => m.id === model) ?? null,
    [providerModels, model]
  );

  useEffect(() => {
    if (!selectedModel || selectedModel.supportedEfforts.length === 0) {
      // Auto-correct effort when the selected model changes; user can still override.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEffort(null);
      return;
    }
    if (effort && selectedModel.supportedEfforts.includes(effort)) return;
    setEffort(selectedModel.defaultEffort ?? selectedModel.supportedEfforts[0]);
  }, [selectedModel, effort]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!provider || !model) return;
    const parsed = Number.parseInt(sessionCountInput, 10);
    const clamped = Number.isFinite(parsed)
      ? Math.max(0, Math.min(parsed, MAX_SESSION_COUNT))
      : DEFAULT_SESSION_COUNT;
    void onSubmit({ sessionCount: clamped, provider, model, effort });
  }

  const canSubmit = !isBusy && !isLoading && !loadError && Boolean(provider && model);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Improve skill: {skillName}</DialogTitle>
          <DialogDescription>
            Launches a new chat session preloaded with a corpus of past sessions where{" "}
            <strong className="text-on-surface">{skillId}</strong> was invoked. The improver agent
            reads the corpus, proposes changes, and writes a new <code>SKILL.md</code> as an
            artifact you can copy back into the inline editor.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {loadError ? (
            <p className="text-sm text-danger">Could not load model list: {loadError}</p>
          ) : null}
          {submitError ? <p className="text-sm text-danger">{submitError}</p> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="improve-provider">Provider</Label>
            <Select
              value={provider ?? ""}
              onValueChange={(value) => setProvider(value as RuntimeProvider)}
              disabled={isLoading || enabledProviders.length === 0}
            >
              <SelectTrigger id="improve-provider">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {enabledProviders.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                    {p === defaultProvider ? " — default" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="improve-model">Model</Label>
            <Select
              value={model ?? ""}
              onValueChange={(value) => setModel(value)}
              disabled={isLoading || providerModels.length === 0}
            >
              <SelectTrigger id="improve-model">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {providerModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}
                    {m.isDefault ? " — default" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {showEffortSelector && selectedModel && selectedModel.supportedEfforts.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="improve-effort">Effort</Label>
              <Select
                value={effort ?? ""}
                onValueChange={(value) => setEffort(value as EffortLevel)}
              >
                <SelectTrigger id="improve-effort">
                  <SelectValue placeholder="Select effort" />
                </SelectTrigger>
                <SelectContent>
                  {selectedModel.supportedEfforts.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                      {selectedModel.defaultEffort === level ? " — default" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="improve-session-count">
              Sessions to analyze (0–{MAX_SESSION_COUNT})
            </Label>
            <Input
              id="improve-session-count"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_SESSION_COUNT}
              value={sessionCountInput}
              onChange={(event) => setSessionCountInput(event.target.value)}
            />
            <p className="text-xs text-on-surface-variant">
              An empty corpus is allowed — the agent will ask what to focus on instead of guessing.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isBusy ? "Launching…" : "Launch improver session"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
