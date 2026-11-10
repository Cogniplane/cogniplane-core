// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import type { Model } from "@cogniplane/shared-types";

import { useEffortPreference } from "./use-effort-preference";

const STORAGE_KEY = "cogniplane:effort";

const denied = (): never => { throw new DOMException("Access is denied for this document.", "SecurityError"); };
const full = (): never => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "model-1",
    displayName: "Model 1",
    description: "",
    isDefault: true,
    provider: "anthropic",
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

  // A blocked or full storage must not crash the chat shell or undo a choice.
  it.each([
    ["the browser blocks storage", () => { vi.spyOn(window, "localStorage", "get").mockImplementation(denied); }],
    ["storage cannot read, save or remove", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied);
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(full);
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(denied);
    }]
  ])("keeps the chosen effort for this page when %s", (_, failStorage) => {
    failStorage();
    const { result, rerender } = renderHook(
      ({ model, enabled }: { model: Model; enabled: boolean }) => useEffortPreference(model, enabled, true),
      { initialProps: { model: makeModel(), enabled: true } }
    );
    expect(result.current.effort).toBe("medium");

    act(() => {
      result.current.setEffort("low");
    });
    expect(result.current.effort).toBe("low");

    rerender({ model: makeModel({ supportedEfforts: ["medium", "high"], defaultEffort: "high" }), enabled: true });
    expect(result.current.effort).toBe("high");

    rerender({ model: makeModel(), enabled: false });
    expect(result.current.effort).toBeNull();
  });
});
