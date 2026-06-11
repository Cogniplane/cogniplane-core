// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

import type { Model } from "@cogniplane/shared-types";

import { useEffortPreference } from "./use-effort-preference";

const STORAGE_KEY = "cogniplane:effort";

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "model-1",
    displayName: "Model 1",
    description: "",
    isDefault: true,
    provider: "codex",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    contextWindow: 200_000,
    ...overrides
  } as Model;
}

describe("useEffortPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("preserves the stored preference but does not expose it while the models query is pending", () => {
    localStorage.setItem(STORAGE_KEY, "high");

    // First render: query pending → model null, selector-flag fallback false.
    const { result, rerender } = renderHook(
      ({ model, enabled, ready }: { model: Model | null; enabled: boolean; ready: boolean }) =>
        useEffortPreference(model, enabled, ready),
      { initialProps: { model: null as Model | null, enabled: false, ready: false } }
    );

    expect(localStorage.getItem(STORAGE_KEY)).toBe("high");
    expect(result.current.effort).toBeNull();

    // Query resolves: selector enabled, model supports the stored effort.
    rerender({ model: makeModel(), enabled: true, ready: true });

    expect(localStorage.getItem(STORAGE_KEY)).toBe("high");
    expect(result.current.effort).toBe("high");
  });

  it("never exposes a stored effort the model does not support", () => {
    localStorage.setItem(STORAGE_KEY, "high");

    const { result } = renderHook(() =>
      useEffortPreference(makeModel({ supportedEfforts: ["low"], defaultEffort: null }), true, true)
    );

    expect(result.current.effort).toBe("low");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("low");
  });

  it("clears the preference when the resolved config disables the selector", () => {
    localStorage.setItem(STORAGE_KEY, "high");

    const { result } = renderHook(() => useEffortPreference(makeModel(), false, true));

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current.effort).toBeNull();
  });

  it("falls back to the model default when the stored effort is unsupported", () => {
    localStorage.setItem(STORAGE_KEY, "high");

    const { result } = renderHook(() =>
      useEffortPreference(makeModel({ supportedEfforts: ["low", "medium"], defaultEffort: "medium" }), true, true)
    );

    expect(result.current.effort).toBe("medium");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("medium");
  });

  it("persists an explicit selection", () => {
    const { result } = renderHook(() => useEffortPreference(makeModel(), true, true));

    expect(result.current.effort).toBe("medium");

    act(() => {
      result.current.setEffort("low");
    });

    expect(result.current.effort).toBe("low");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("low");
  });
});
