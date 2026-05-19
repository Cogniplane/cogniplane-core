"use client";

import { useCallback, useEffect, useState } from "react";

import type { EffortLevel, Model } from "@cogniplane/shared-types";

const STORAGE_KEY = "cogniplane:effort";

function resolveModelEffort(model: Model | null): EffortLevel | null {
  if (!model) return null;
  return model.defaultEffort ?? model.supportedEfforts[0] ?? null;
}

export function useEffortPreference(model: Model | null, enabled: boolean) {
  const [effort, setEffortState] = useState<EffortLevel | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? stored as EffortLevel : null;
  });

  const setEffort = useCallback((next: EffortLevel | null) => {
    if (next === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, next);
    }
    setEffortState(next);
  }, []);

  useEffect(() => {
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
  }, [effort, enabled, model, setEffort]);

  return { effort, setEffort };
}
