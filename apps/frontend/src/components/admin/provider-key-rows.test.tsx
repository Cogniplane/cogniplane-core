// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderKeyRows } from "./provider-key-rows";

afterEach(cleanup);

it("opens and focuses the linked provider without saving a key", () => {
  const onSaveProviderKey = vi.fn(async () => true);
  const props = {
    tenant: null,
    busyKey: null,
    providerSuccessMessage: {},
    providerErrorMessage: { google: "Failed to save Google API key." },
    providerStatuses: [],
    onSaveProviderKey,
    status: () => "Off.",
    actions: () => null
  };
  const page = render(<ProviderKeyRows {...props} targetProvider="google" />);
  const google = screen.getByRole("button", { name: "Set up Google key" });
  expect(google.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(google);
  expect(screen.getByRole("alert").textContent).toBe("Failed to save Google API key.");
  expect(screen.getByRole("button", { name: "Set up Anthropic key" }).getAttribute("aria-expanded")).toBe("false");
  expect(onSaveProviderKey).not.toHaveBeenCalled();
  page.rerender(<ProviderKeyRows {...props} targetProvider="openai" />);
  const openai = screen.getByRole("button", { name: "Set up OpenAI key" });
  expect(openai.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(openai);
  expect(onSaveProviderKey).not.toHaveBeenCalled();
});

it("does not reopen a form the admin closed until a new link points to it", () => {
  const props = { tenant: null, busyKey: null, providerSuccessMessage: {}, providerErrorMessage: {}, providerStatuses: [], onSaveProviderKey: async () => true, status: () => "Off.", actions: () => null };
  render(<ProviderKeyRows {...props} targetProvider="google" />);
  const google = screen.getByRole("button", { name: "Set up Google key" });
  fireEvent.click(google);
  expect(google.getAttribute("aria-expanded")).toBe("false");
});
