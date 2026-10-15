"use client";

import { useCallback, useEffect, useState } from "react";
import type { Model } from "@cogniplane/shared-types";

const STORAGE_KEY = "cogniplane:model";
// Used until the model list arrives. A saved choice takes precedence.
const DEFAULT_MODEL = "deepagents/claude-haiku-5-5";

export function useModelPreference(filteredModels?: Model[]) {
  const [model, setModelState] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_MODEL;
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_MODEL;
  });

  const setModel = useCallback((next: string) => {
    localStorage.setItem(STORAGE_KEY, next);
    setModelState(next);
  }, []);

  // Follow the organization default when no saved choice remains available.
  useEffect(() => {
    if (!filteredModels || filteredModels.length === 0) return;
    const storedModelExists = filteredModels.some((m) => m.id === model);
    const hasExplicitChoice = typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY) === model;
    if (storedModelExists && hasExplicitChoice) return;
    const fallback =
      filteredModels.find((m) => m.isDefault) ?? filteredModels[0];
    if (fallback) {
      // A missing or unavailable preference follows the organization default.
      // Keep this fallback out of storage so later admin changes take effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModelState(fallback.id);
    }
  }, [filteredModels, model]);

  return { model, setModel };
}
