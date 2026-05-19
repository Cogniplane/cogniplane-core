"use client";

import { useCallback, useEffect, useState } from "react";
import type { Model } from "@cogniplane/shared-types";

const STORAGE_KEY = "cogniplane:model";
const DEFAULT_MODEL = "gpt-5.4-mini";

export function useModelPreference(filteredModels?: Model[]) {
  const [model, setModelState] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_MODEL;
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_MODEL;
  });

  const setModel = useCallback((next: string) => {
    localStorage.setItem(STORAGE_KEY, next);
    setModelState(next);
  }, []);

  // Auto-correct when the stored model is not in the filtered list
  useEffect(() => {
    if (!filteredModels || filteredModels.length === 0) return;
    const storedModelExists = filteredModels.some((m) => m.id === model);
    if (storedModelExists) return;
    const fallback =
      filteredModels.find((m) => m.isDefault) ?? filteredModels[0];
    if (fallback) {
      // Auto-correct stored model when filtered list no longer contains it;
      // setModel also persists to localStorage (external system sync).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModel(fallback.id);
    }
  }, [filteredModels, model, setModel]);

  return { model, setModel };
}
