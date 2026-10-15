// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";

import { AdminPiiProtectionSection } from "./admin-pii-protection-section";

afterEach(cleanup);

function renderSection(value: PiiProtectionSettings, onSave: (next: PiiProtectionSettings) => Promise<boolean> = vi.fn(async () => true)) {
  const view = render(<AdminPiiProtectionSection value={value} busy={false} error={null} savedMessage={null} onSave={onSave} />);
  return { onSave, view };
}

it("shows the effective Off state for a legacy disabled mode and keeps it disabled on other edits", async () => {
  const legacy = { ...DEFAULT_PII_PROTECTION, enabled: false, mode: "detect" as const };
  const { onSave } = renderSection(legacy);
  expect(screen.getByRole("combobox", { name: "Protection mode" }).textContent).toContain("Off");
  expect(screen.getByText("No PII scans run.")).toBeTruthy();
  // Nothing to save, so the save buttons stay out of the way.
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

  fireEvent.click(screen.getByRole("checkbox", { name: "Direct uploads" }));
  expect(screen.getByRole("status").textContent).toContain("Unsaved changes");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    enabled: false,
    mode: "detect",
    scopes: expect.objectContaining({ uploads: false })
  })));
});

it("activates the selected mode in one saved policy", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const { onSave } = renderSection(DEFAULT_PII_PROTECTION);
  fireEvent.click(screen.getByRole("combobox", { name: "Protection mode" }));
  fireEvent.click(await screen.findByRole("option", { name: "Block" }));
  // Until the save, the row says which mode is still in effect.
  expect(screen.getByText(/Saved mode: Off\./)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, mode: "block" })));
});

function unloadPrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

it("asks before the page unloads only while the draft has changes", () => {
  renderSection({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" });
  expect(unloadPrevented()).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Chat prompts" }));
  expect(unloadPrevented()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(unloadPrevented()).toBe(false);
});

it("Cancel restores the saved values and keeps focus on the form", () => {
  renderSection({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Chat prompts" }));
  expect(screen.getByRole("combobox", { name: "Protection mode" }).textContent).toContain("Block");
  expect(screen.getByText("Direct uploads and Microsoft imports.")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Unsaved changes");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect((screen.getByRole("checkbox", { name: "Chat prompts" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("");
  expect(document.activeElement).toBe(screen.getByRole("status"));
  expect(screen.getByText("Chat prompts, Direct uploads and Microsoft imports.")).toBeTruthy();
});

it("keeps provider and detector tuning under Edit detection and places save errors by the action", () => {
  const onSave = vi.fn(async () => false);
  const { view } = renderSection(DEFAULT_PII_PROTECTION, onSave);
  const edit = screen.getByRole("button", { name: "Edit detection" });
  expect(edit.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByLabelText("PII detection model").closest("[hidden]")).not.toBeNull();
  expect(screen.getByText("Looks for all personal data types. Model: deployment default.")).toBeTruthy();
  expect(screen.getByText("Stored findings omit the matched text.")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Direct uploads" }));
  view.rerender(<AdminPiiProtectionSection value={DEFAULT_PII_PROTECTION} busy={false} error="Save failed." savedMessage={null} onSave={onSave} />);
  // An error from an earlier attempt is not shown before this form saves.
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  return waitFor(() => {
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Save failed.");
    expect(alert.parentElement?.contains(screen.getByRole("button", { name: "Save changes" }))).toBe(true);
  });
});

it("leaves edit mode after a save whose model name the server trims", async () => {
  let saved = DEFAULT_PII_PROTECTION;
  const onSave = vi.fn(async (next: PiiProtectionSettings) => { saved = next; return true; });
  const { view } = renderSection(DEFAULT_PII_PROTECTION, onSave);
  fireEvent.change(screen.getByLabelText("PII detection model"), { target: { value: " gpt-pii " } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(saved.provider.model).toBe("gpt-pii");
  view.rerender(<AdminPiiProtectionSection value={saved} busy={false} error={null} savedMessage="PII protection settings saved." onSave={onSave} />);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
  expect(screen.getByRole("status").textContent).toBe("PII protection settings saved.");
  expect(document.activeElement).toBe(screen.getByRole("status"));
});

it("restores a legacy Off policy exactly when Off is picked again", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  renderSection({ ...DEFAULT_PII_PROTECTION, enabled: false, mode: "detect" });
  fireEvent.click(screen.getByRole("combobox", { name: "Protection mode" }));
  fireEvent.click(await screen.findByRole("option", { name: "Detect" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Protection mode" }));
  fireEvent.click(await screen.findByRole("option", { name: "Off" }));
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
});

it("warns that Detect keeps matched values readable for admins", () => {
  renderSection({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect", rawRetention: "admin_only" });
  expect(screen.getByText("Matched values remain readable in admin findings.")).toBeTruthy();
});

it.each([
  ["admin_only", "readable by admins"],
  ["reversible_encrypted", "encrypted"]
] as const)("explains retained matches when Transform uses %s", (rawRetention, storage) => {
  renderSection({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "transform", rawRetention });
  expect(screen.getByText(`The agent receives redacted chat prompts. Original matched values remain stored ${storage} in findings.`)).toBeTruthy();
});
