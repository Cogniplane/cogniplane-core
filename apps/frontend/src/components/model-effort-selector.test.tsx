// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { EffortLevel, Model } from "@cogniplane/shared-types";

import { ModelEffortSelector } from "./model-effort-selector";

// AnimatedHeight (inside the popover) measures itself with a ResizeObserver
// and checks prefers-reduced-motion via matchMedia; jsdom provides neither.
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {}
    })
  );
});

afterEach(cleanup);

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "deepagents/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    description: "Fast, intelligent model.",
    isDefault: true,
    provider: "anthropic",
    supportedEfforts: [],
    defaultEffort: null,
    contextWindow: 1_000_000,
    ...overrides
  };
}

const plainSonnet = makeModel();
const reasoningSonnet = makeModel({
  supportedEfforts: ["low", "medium", "high", "max"] as EffortLevel[],
  defaultEffort: "medium"
});
const anthropicHaiku = makeModel({
  id: "deepagents/claude-haiku-4-5",
  displayName: "Claude Haiku 4.5",
  isDefault: false
});
const openaiGpt = makeModel({
  id: "openai/gpt-5.5",
  displayName: "GPT-5.5",
  isDefault: false,
  provider: "openai"
});
// Flagged as OpenAI's default but ordered AFTER openaiGpt, so "pick the
// default" is distinguishable from "pick the first".
const openaiGptDefault = makeModel({
  id: "openai/gpt-5.6",
  displayName: "GPT-5.6",
  isDefault: true,
  provider: "openai"
});

function renderSelector(props: Partial<React.ComponentProps<typeof ModelEffortSelector>> = {}) {
  const onModelChange = vi.fn();
  const onEffortChange = vi.fn();
  render(
    <ModelEffortSelector
      model={props.model ?? plainSonnet.id}
      effort={props.effort ?? null}
      models={props.models ?? [plainSonnet]}
      showEffortSelector={props.showEffortSelector}
      disabled={props.disabled}
      onModelChange={onModelChange}
      onEffortChange={onEffortChange}
    />
  );
  return { onModelChange, onEffortChange };
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { expanded: false });
}

function openPopover(): HTMLElement {
  fireEvent.click(trigger());
  return screen.getByRole("dialog");
}

describe("ModelEffortSelector", () => {
  it("shows the selected model and effort on the trigger pill", () => {
    renderSelector({ models: [reasoningSonnet], effort: "medium", showEffortSelector: true });
    const pill = trigger();
    expect(within(pill).getByText("Claude Sonnet 5")).toBeTruthy();
    expect(within(pill).getByText("Medium")).toBeTruthy();
  });

  it("omits the effort label when the model advertises no efforts", () => {
    renderSelector({ models: [plainSonnet], showEffortSelector: true });
    expect(within(trigger()).queryByText("Medium")).toBeNull();
  });

  it("omits the effort label when showEffortSelector is off, even for a reasoning model", () => {
    renderSelector({ models: [reasoningSonnet], effort: "medium", showEffortSelector: false });
    expect(within(trigger()).queryByText("Medium")).toBeNull();
  });

  it("opens on the slider view for an effort-capable model", () => {
    renderSelector({ models: [reasoningSonnet], effort: "medium", showEffortSelector: true });
    const popover = openPopover();
    expect(within(popover).getByRole("slider", { name: "Reasoning effort" })).toBeTruthy();
    expect(within(popover).getByText("Advanced")).toBeTruthy();
  });

  it("opens straight on the Advanced menu when effort is unavailable", () => {
    renderSelector({ models: [plainSonnet, anthropicHaiku], showEffortSelector: false });
    const popover = openPopover();
    expect(within(popover).queryByRole("slider")).toBeNull();
    // No slider to collapse back to, so no "Advanced" toggle row either.
    expect(within(popover).queryByText("Advanced")).toBeNull();
    expect(within(popover).getByRole("button", { name: /^Model/ })).toBeTruthy();
    expect(within(popover).queryByRole("button", { name: /^Effort/ })).toBeNull();
  });

  it("slider arrow keys step through the model's supported efforts", () => {
    const { onEffortChange } = renderSelector({
      models: [reasoningSonnet],
      effort: "medium",
      showEffortSelector: true
    });
    const slider = within(openPopover()).getByRole("slider", { name: "Reasoning effort" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onEffortChange).toHaveBeenCalledWith("high");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onEffortChange).toHaveBeenCalledWith("low");
    fireEvent.keyDown(slider, { key: "End" });
    expect(onEffortChange).toHaveBeenCalledWith("max");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onEffortChange).toHaveBeenCalledWith("low");
  });

  it("slider reflects the current effort in its ARIA state", () => {
    renderSelector({ models: [reasoningSonnet], effort: "high", showEffortSelector: true });
    const slider = within(openPopover()).getByRole("slider", { name: "Reasoning effort" });
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    expect(slider.getAttribute("aria-valuemax")).toBe("3");
    expect(slider.getAttribute("aria-valuetext")).toBe("High");
  });

  it("Advanced view exposes Model and Effort rows and collapses back to the slider", () => {
    renderSelector({ models: [reasoningSonnet], effort: "medium", showEffortSelector: true });
    const popover = openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Advanced/ }));
    expect(within(popover).getByRole("button", { name: /Model/ })).toBeTruthy();
    expect(within(popover).getByRole("button", { name: /Effort/ })).toBeTruthy();
    expect(within(popover).queryByRole("slider")).toBeNull();
    fireEvent.click(within(popover).getByRole("button", { name: /Advanced/ }));
    expect(within(popover).getByRole("slider")).toBeTruthy();
  });

  it("selecting a model from the Advanced drill-in fires onModelChange and closes", () => {
    const { onModelChange } = renderSelector({
      models: [reasoningSonnet, anthropicHaiku],
      effort: "medium",
      showEffortSelector: true
    });
    const popover = openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Advanced/ }));
    fireEvent.click(within(popover).getByRole("button", { name: /^Model/ }));
    fireEvent.click(within(popover).getByRole("button", { name: /Claude Haiku 4\.5/ }));
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith(anthropicHaiku.id);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("re-selecting the current model closes without firing onModelChange", () => {
    const { onModelChange } = renderSelector({ models: [plainSonnet, anthropicHaiku] });
    const popover = openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /^Model/ }));
    fireEvent.click(within(popover).getByRole("button", { name: /Claude Sonnet 5/ }));
    expect(onModelChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the Provider row only when models span more than one provider", () => {
    renderSelector({ models: [plainSonnet, anthropicHaiku, openaiGpt] });
    const popover = openPopover();
    const providerRow = within(popover).getByRole("button", { name: /^Provider/ });
    expect(within(providerRow).getByText("Anthropic")).toBeTruthy();
  });

  it("hides the Provider row for a single-provider model list", () => {
    renderSelector({ models: [plainSonnet, anthropicHaiku] });
    const popover = openPopover();
    expect(within(popover).queryByRole("button", { name: /^Provider/ })).toBeNull();
  });

  it("selecting a provider auto-picks that provider's default model", () => {
    // OpenAI has two models with gpt-5.6 flagged default, listed after gpt-5.5,
    // so this can't pass by picking the first.
    const { onModelChange } = renderSelector({
      models: [plainSonnet, openaiGpt, openaiGptDefault]
    });
    const popover = openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /^Provider/ }));
    fireEvent.click(within(popover).getByRole("button", { name: "OpenAI" }));
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith(openaiGptDefault.id);
    // Returns to the Advanced menu rather than closing: the user likely wants
    // to pick a specific model next.
    expect(within(popover).getByRole("button", { name: /^Model/ })).toBeTruthy();
  });

  it("selecting a provider with no default model falls back to its first model", () => {
    const { onModelChange } = renderSelector({ models: [plainSonnet, openaiGpt] });
    const popover = openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /^Provider/ }));
    fireEvent.click(within(popover).getByRole("button", { name: "OpenAI" }));
    expect(onModelChange).toHaveBeenCalledWith(openaiGpt.id);
  });

  it("re-selecting the current provider is a no-op", () => {
    const { onModelChange } = renderSelector({ models: [plainSonnet, openaiGpt] });
    const popover = openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /^Provider/ }));
    fireEvent.click(within(popover).getByRole("button", { name: "Anthropic" }));
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("the Model drill-in lists only the selected provider's models", () => {
    renderSelector({ models: [plainSonnet, anthropicHaiku, openaiGpt] });
    const popover = openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /^Model/ }));
    expect(within(popover).getByText("Claude Haiku 4.5")).toBeTruthy();
    expect(within(popover).queryByText("GPT-5.5")).toBeNull();
  });

  it("selecting an effort from the Advanced drill-in fires onEffortChange and closes", () => {
    const { onEffortChange } = renderSelector({
      models: [reasoningSonnet],
      effort: "medium",
      showEffortSelector: true
    });
    const popover = openPopover();
    fireEvent.click(within(popover).getByRole("button", { name: /Advanced/ }));
    fireEvent.click(within(popover).getByRole("button", { name: /^Effort/ }));
    fireEvent.click(within(popover).getByRole("button", { name: "Max" }));
    expect(onEffortChange).toHaveBeenCalledWith("max");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables the trigger while a turn is running", () => {
    renderSelector({ models: [plainSonnet], disabled: true });
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
  });
});
