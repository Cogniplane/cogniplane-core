// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Model } from "@cogniplane/shared-types";
import { ModelEffortSelector } from "./model-effort-selector";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(cleanup);

const sonnet: Model = { id: "anthropic/sonnet", displayName: "Sonnet", description: "", isDefault: true, provider: "anthropic", supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 100000 };
const gpt: Model = { id: "openai/gpt", displayName: "GPT", description: "", isDefault: false, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 100000 };

function setup() {
  const onModelChange = vi.fn();
  const onEffortChange = vi.fn();
  render(<ModelEffortSelector model={sonnet.id} effort="medium" models={[sonnet, gpt]} showEffortSelector onModelChange={onModelChange} onEffortChange={onEffortChange} />);
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  return { onModelChange, onEffortChange, dialog: screen.getByRole("dialog") };
}

test("opens a searchable model list grouped by provider", () => {
  const { dialog, onModelChange } = setup();
  expect(within(dialog).getByText("Anthropic")).toBeTruthy();
  expect(within(dialog).getByText("OpenAI")).toBeTruthy();
  fireEvent.change(within(dialog).getByRole("searchbox", { name: "Choose a model" }), { target: { value: "GPT" } });
  expect(within(dialog).queryByRole("button", { name: "Sonnet" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "GPT" }));
  expect(onModelChange).toHaveBeenCalledWith(gpt.id);
});

test("keeps effort secondary and preserves explicit model choice", () => {
  const { dialog, onModelChange, onEffortChange } = setup();
  expect(within(dialog).getByRole("button", { name: "Sonnet" })).toBeTruthy();
  fireEvent.click(within(dialog).getByText("Reasoning effort: medium"));
  fireEvent.click(within(dialog).getByRole("button", { name: "high" }));
  expect(onEffortChange).toHaveBeenCalledWith("high");
  expect(onModelChange).not.toHaveBeenCalled();
});

test("reselecting the current model closes without changing it", () => {
  const { dialog, onModelChange } = setup();
  const current = within(dialog).getByRole("button", { name: "Sonnet" });
  expect(current.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(current);
  expect(onModelChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each([
  { model: sonnet, enabled: false },
  { model: gpt, enabled: true }
])("hides unsupported or disabled effort controls", ({ model, enabled }) => {
  render(<ModelEffortSelector model={model.id} effort="medium" models={[model]} showEffortSelector={enabled} onModelChange={vi.fn()} onEffortChange={vi.fn()} />);
  expect(screen.queryByText("medium")).toBeNull();
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  expect(screen.queryByText(/Reasoning effort/)).toBeNull();
});

test.each([true, false])("prevents model selection when disabled or empty", (disabled) => {
  render(<ModelEffortSelector model={sonnet.id} effort="medium" models={disabled ? [sonnet] : []} disabled={disabled} onModelChange={vi.fn()} onEffortChange={vi.fn()} />);
  const trigger = screen.getByRole("button");
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
});
