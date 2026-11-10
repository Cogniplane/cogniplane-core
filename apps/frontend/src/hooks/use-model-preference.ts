"use client";

import { useCallback, useEffect, useState } from "react";
import type { Model } from "@cogniplane/shared-types";

const STORAGE_KEY = "cogniplane:model";
// Used until the model list arrives. A saved choice takes precedence.
const DEFAULT_MODEL = "deepagents/claude-haiku-5-5";

// A browser that blocks site data throws on any storage access, and a full
// storage throws on a write. The choice then applies to this page only.
function readSavedModel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveModel(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Blocked or full storage: the choice stays in memory.
  }
}

export function useModelPreference(filteredModels?: Model[]) {
  // The user's choice, saved or not. The effect compares the model with this
  // value, not with storage. When a save fails, storage does not hold the
  // choice, so a storage check would replace each choice with the default.
  const [choice, setChoice] = useState<string | null>(readSavedModel);
  const [model, setModelState] = useState<string>(() => choice ?? DEFAULT_MODEL);

  const setModel = useCallback((next: string) => {
    setChoice(next);
    setModelState(next);
    saveModel(next);
  }, []);

  // Follow the organization default when the user's choice is not available.
  useEffect(() => {
    if (!filteredModels || filteredModels.length === 0) return;
    const storedModelExists = filteredModels.some((m) => m.id === model);
    if (storedModelExists && choice === model) return;
    const fallback =
      filteredModels.find((m) => m.isDefault) ?? filteredModels[0];
    if (fallback) {
      // A missing or unavailable preference follows the organization default.
      // Keep this fallback out of storage so later admin changes take effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModelState(fallback.id);
    }
  }, [choice, filteredModels, model]);

  return { model, setModel };
}
