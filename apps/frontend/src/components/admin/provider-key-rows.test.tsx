// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TenantDetails } from "@cogniplane/shared-types";
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

const knownTenant = { settings: { providerKeys: { openrouter: true, openai: false } } } as unknown as TenantDetails;
function keyForms(onSaveProviderKey: (provider: never, key: string) => Promise<boolean>) {
  return render(<ProviderKeyRows tenant={knownTenant} busyKey={null} providerSuccessMessage={{}} providerErrorMessage={{}} providerStatuses={[]} onSaveProviderKey={onSaveProviderKey as never} status={() => "On."} actions={() => null} />);
}

it("blocks competing and duplicate writes without clearing another provider's input", async () => {
  let finish!: (ok: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  keyForms(save);
  fireEvent.click(screen.getByRole("button", { name: "Set up OpenAI key" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace key OpenRouter key" }));
  fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "INERT-SAMPLE-NOT-A-KEY" } });
  const other = screen.getByLabelText("OpenRouter API key") as HTMLInputElement;
  fireEvent.change(other, { target: { value: "INERT-OTHER-SAMPLE" } });
  const [first, second] = screen.getAllByRole("button", { name: "Save API key" });
  fireEvent.click(first);
  fireEvent.click(first);
  fireEvent.click(second);
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Saving OpenAI key..." })).toBeTruthy();
  expect((second as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish(true));
  expect((screen.getByLabelText("OpenAI API key") as HTMLInputElement).value).toBe("");
  expect(other.value).toBe("INERT-OTHER-SAMPLE");
});

it("keeps named key removal pending and retains the decision and input after failure", async () => {
  let finish!: (ok: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  keyForms(save);
  fireEvent.click(screen.getByRole("button", { name: "Replace key OpenRouter key" }));
  const input = screen.getByLabelText("OpenRouter API key") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "INERT-SAMPLE-NOT-A-KEY" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText(/platform key can still provide access/)).toBeTruthy();
  const remove = screen.getByRole("button", { name: "Remove OpenRouter organization key" });
  remove.focus();
  fireEvent.click(remove);
  expect(document.activeElement?.textContent).toBe("Removing OpenRouter organization key...");
  expect(document.activeElement?.getAttribute("role")).toBe("status");
  expect(screen.getByRole("button", { name: "Removing OpenRouter key..." })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Keep key" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish(false));
  expect(save).toHaveBeenCalledWith("openrouter", "");
  expect(input.value).toBe("INERT-SAMPLE-NOT-A-KEY");
  expect(screen.getByRole("alert").textContent).toContain("removal was not confirmed");
  expect(screen.getByRole("button", { name: "Remove OpenRouter organization key" })).toBeTruthy();
  expect(document.activeElement?.getAttribute("role")).toBe("status");
});

it.each([false, true])("keeps completion focus after the key removal decision unmounts, moved elsewhere: %s", async (moveAway) => {
  let finish!: (ok: boolean) => void;
  keyForms(() => new Promise<boolean>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Replace key OpenRouter key" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  const remove = screen.getByRole("button", { name: "Remove OpenRouter organization key" });
  remove.focus();
  fireEvent.click(remove);
  const outside = screen.getByRole("button", { name: "Set up Google key" });
  if (moveAway) outside.focus();
  await act(async () => finish(true));
  expect(document.activeElement).toBe(moveAway ? outside : screen.getByText("OpenRouter organization key removed."));
  expect(screen.queryByText("Remove the OpenRouter organization key?")).toBeNull();
});

it("blocks key changes while organization key presence is unknown", () => {
  const save = vi.fn(async () => true);
  render(<ProviderKeyRows tenant={null} targetProvider="openai" busyKey={null} providerSuccessMessage={{}} providerErrorMessage={{}} providerStatuses={[]} onSaveProviderKey={save} status={() => "Unknown."} actions={() => null} />);
  expect((screen.getByLabelText("OpenAI API key") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getAllByText(/Load key status before making changes/)[0]).toBeTruthy();
  fireEvent.submit(screen.getByLabelText("OpenAI API key").closest("form")!);
  expect(save).not.toHaveBeenCalled();
});

it("does not reopen a form the admin closed until a new link points to it", () => {
  const props = { tenant: null, busyKey: null, providerSuccessMessage: {}, providerErrorMessage: {}, providerStatuses: [], onSaveProviderKey: async () => true, status: () => "Off.", actions: () => null };
  render(<ProviderKeyRows {...props} targetProvider="google" />);
  const google = screen.getByRole("button", { name: "Set up Google key" });
  fireEvent.click(google);
  expect(google.getAttribute("aria-expanded")).toBe("false");
});
