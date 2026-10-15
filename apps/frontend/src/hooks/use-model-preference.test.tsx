// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Model } from "@cogniplane/shared-types";
import { useModelPreference } from "./use-model-preference";

const sonnet: Model = { id: "anthropic/sonnet", displayName: "Sonnet", description: "", provider: "anthropic", isDefault: true, supportedEfforts: [], defaultEffort: null, contextWindow: 100000 };
const gpt: Model = { ...sonnet, id: "openai/gpt", displayName: "GPT", provider: "openai", isDefault: false };

afterEach(() => { cleanup(); localStorage.clear(); });

test("uses the organization default until a user makes an explicit choice", async () => {
  const { result, rerender } = renderHook(({ models }) => useModelPreference(models), {
    initialProps: { models: [sonnet, gpt] }
  });
  await waitFor(() => expect(result.current.model).toBe(sonnet.id));
  expect(localStorage.getItem("cogniplane:model")).toBeNull();

  rerender({ models: [{ ...sonnet, isDefault: false }, { ...gpt, isDefault: true }] });
  await waitFor(() => expect(result.current.model).toBe(gpt.id));
  expect(localStorage.getItem("cogniplane:model")).toBeNull();
});

test("keeps an explicit model when the organization default changes", async () => {
  const { result, rerender } = renderHook(({ models }) => useModelPreference(models), {
    initialProps: { models: [sonnet, gpt] }
  });
  act(() => result.current.setModel(gpt.id));
  rerender({ models: [{ ...sonnet, isDefault: true }, gpt] });
  expect(result.current.model).toBe(gpt.id);
  expect(localStorage.getItem("cogniplane:model")).toBe(gpt.id);
});

test("falls back when an explicit model disappears without saving the fallback", async () => {
  const { result, rerender } = renderHook(({ models }) => useModelPreference(models), {
    initialProps: { models: [sonnet, gpt] }
  });
  act(() => result.current.setModel(gpt.id));
  expect(localStorage.getItem("cogniplane:model")).toBe(gpt.id);

  rerender({ models: [sonnet] });
  await waitFor(() => expect(result.current.model).toBe(sonnet.id));
  expect(localStorage.getItem("cogniplane:model")).toBe(gpt.id);

  rerender({ models: [sonnet, gpt] });
  expect(result.current.model).toBe(sonnet.id);
  expect(localStorage.getItem("cogniplane:model")).toBe(gpt.id);
});
