"use client";

import { useCallback, useEffect, useState } from "react";

import type { EffortLevel, Model } from "@cogniplane/shared-types";

const STORAGE_KEY = "cogniplane:effort";

function resolveModelEffort(model: Model | null): EffortLevel | null {
  if (!model) return null;
  return model.defaultEffort ?? model.supportedEfforts[0] ?? null;
}

// A browser that blocks site data throws on any storage access, and a full
// storage throws on a write. The effort then applies to this page only.
function readSavedEffort(): EffortLevel | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? stored as EffortLevel : null;
  } catch {
    return null;
  }
}

function saveEffort(effort: EffortLevel | null): void {
  try {
    if (effort === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, effort);
    }
  } catch {
    // Blocked or full storage: the effort stays in memory.
  }
}

export function useEffortPreference(model: Model | null, enabled: boolean, ready: boolean) {
  const [effort, setEffortState] = useState<EffortLevel | null>(readSavedEffort);

  const setEffort = useCallback((next: EffortLevel | null) => {
    setEffortState(next);
    saveEffort(next);
  }, []);

  useEffect(() => {
    // Before the models query resolves, `enabled`/`model` are fallback
    // defaults — syncing against them would wipe the stored preference.
    if (!ready) return;

    if (!enabled) {
      // Auto-correct stored effort when the selected model changes; setEffort
      // here also persists to localStorage (external system sync).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEffort(null);
      return;
    }

    if (!model || model.supportedEfforts.length === 0) {
      setEffort(null);
      return;
    }

    if (effort && model.supportedEfforts.includes(effort)) {
      return;
    }

    setEffort(resolveModelEffort(model));
  }, [effort, enabled, model, ready, setEffort]);

  // Never return the raw state: it holds the stored value before the config
  // can validate it, and a send must omit effort rather than submit that.
  const validatedEffort =
    ready && enabled && model && effort && model.supportedEfforts.includes(effort)
      ? effort
      : null;

  return { effort: validatedEffort, setEffort };
}
