// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";

import { registerPiiScopeLabel } from "@/lib/pii-scope-labels";
import type { PiiSaveResult } from "@/hooks/use-admin-organization-data";
import { AdminPiiProtectionSection } from "./admin-pii-protection-section";

afterEach(cleanup);

function renderSection(value: PiiProtectionSettings, onSave: (next: PiiProtectionSettings) => Promise<PiiSaveResult> = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: true }))) {
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
  // Without a revision from the server, the save sends none.
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    enabled: false,
    mode: "detect",
    scopes: expect.objectContaining({ uploads: false })
  }), undefined));
});

it("activates the selected mode in one saved policy", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const { onSave } = renderSection(DEFAULT_PII_PROTECTION);
  fireEvent.click(screen.getByRole("combobox", { name: "Protection mode" }));
  fireEvent.click(await screen.findByRole("option", { name: "Block" }));
  // Until the save, the row says which mode is still in effect.
  expect(screen.getByText(/Saved mode: Off\./)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, mode: "block" }), undefined));
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
  expect(screen.getByText("Direct uploads.")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Unsaved changes");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect((screen.getByRole("checkbox", { name: "Chat prompts" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("");
  expect(document.activeElement).toBe(screen.getByRole("status"));
  expect(screen.getByText("Chat prompts and Direct uploads.")).toBeTruthy();
});

it("keeps provider and detector tuning under Edit detection and places save errors by the action", () => {
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: false }));
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
  const onSave = vi.fn(async (next: PiiProtectionSettings) => { saved = next; return { ok: true } as const; });
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

it("shows only the core scopes when the server returns no import scope", () => {
  renderSection(DEFAULT_PII_PROTECTION);
  expect(screen.getAllByRole("checkbox", { name: /prompts|uploads|imports/i }).map((box) => box.id)).toEqual(["pii-scope-chat", "pii-scope-uploads"]);
  expect(document.body.textContent).not.toMatch(/Microsoft/);
});

it("shows each import scope that the server returns, with its registered label, and saves it", async () => {
  registerPiiScopeLabel({ scopeKey: "partnerImports", label: "Partner imports" });
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: true }));
  renderSection({ ...DEFAULT_PII_PROTECTION, scopes: { chatPrompts: true, uploads: true, partnerImports: true, otherImports: false } }, onSave);
  expect(screen.getByText("Chat prompts, Direct uploads and Partner imports.")).toBeTruthy();
  // Without a registered label, the scope key names the scope.
  expect((screen.getByRole("checkbox", { name: "otherImports" }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Partner imports" }));
  expect(screen.getByRole("checkbox", { name: "Partner imports" }).id).toBe("pii-scope-partnerImports");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    scopes: { chatPrompts: true, uploads: true, partnerImports: false, otherImports: false }
  }), undefined));
});

const NEWER_POLICY: PiiProtectionSettings = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" };
const uploadsBox = () => screen.getByRole("checkbox", { name: "Direct uploads" }) as HTMLInputElement;

it("saves with the revision that the draft is based on, also after a refresh during the edit", async () => {
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: true }));
  const props = { busy: false, error: null, savedMessage: null, onSave };
  const view = render(<AdminPiiProtectionSection {...props} value={DEFAULT_PII_PROTECTION} revision={3} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Direct uploads" }));
  // Another session saved. A refresh brings its settings while this draft is open.
  view.rerender(<AdminPiiProtectionSection {...props} value={NEWER_POLICY} revision={4} />);
  expect(uploadsBox().checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "off", scopes: expect.objectContaining({ uploads: false }) }),
    3
  ));
});

it("keeps the draft after a conflict and offers to reload the current settings", async () => {
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: false }));
  const props = { busy: false, savedMessage: null, onSave };
  const message = "These settings changed in another session. Your changes are not saved. Reload to see the current settings.";
  const view = render(<AdminPiiProtectionSection {...props} value={DEFAULT_PII_PROTECTION} revision={3} error={null} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Direct uploads" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  // The failed save read the current settings again.
  view.rerender(<AdminPiiProtectionSection {...props} value={NEWER_POLICY} revision={4} error={message} conflict />);

  expect(screen.getByRole("alert").textContent).toBe(message);
  expect(uploadsBox().checked).toBe(false);
  expect(screen.getByText(/Saved mode: Block\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  expect(uploadsBox().checked).toBe(true);
  expect(screen.getByRole("combobox", { name: "Protection mode" }).textContent).toContain("Block");
  expect(screen.queryByRole("alert")).toBeNull();

  // The next save is based on the current revision.
  fireEvent.click(screen.getByRole("checkbox", { name: "Chat prompts" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "block" }), 4));
});

it("bases the next save on the revision that its own save returned", async () => {
  // The admin edits again while the first save runs, so the refresh does not
  // equal the draft and does not end the edit.
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: true, revision: 4 }));
  const props = { busy: false, error: null, savedMessage: null, onSave };
  const view = render(<AdminPiiProtectionSection {...props} value={DEFAULT_PII_PROTECTION} revision={3} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Direct uploads" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Chat prompts" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), 3));
  view.rerender(<AdminPiiProtectionSection {...props} value={{ ...DEFAULT_PII_PROTECTION, scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: false } }} revision={4} />);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.anything(), 4));
});

it("bases the next save on the returned revision when the refresh after a save fails", async () => {
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: true, revision: 4 }));
  render(<AdminPiiProtectionSection busy={false} error={null} savedMessage={null} onSave={onSave} value={DEFAULT_PII_PROTECTION} revision={3} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Direct uploads" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), 3));
  // No refresh arrives. The props still show revision 3.
  fireEvent.click(screen.getByRole("checkbox", { name: "Chat prompts" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.anything(), 4));
});

const SHOWN_POLICY: PiiProtectionSettings = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" };
const OK_HEALTH = { state: "ok" as const, reasons: [], fields: [] };

it.each([
  ["error", "alert", "The stored PII policy is not valid."],
  ["warning", "status", "Part of the stored PII policy is not valid."]
] as const)("asks for a save of the shown values, with no change, when the policy health is %s", async (state, role, text) => {
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: true, revision: 3 }));
  const props = { busy: false, error: null, onSave };
  const health = { state, reasons: ["mode_invalid"], fields: ["mode"] };
  const view = render(<AdminPiiProtectionSection {...props} value={SHOWN_POLICY} revision={2} health={health} savedMessage={null} />);

  const notice = screen.getAllByRole(role).find((element) => element.textContent?.includes(text));
  expect(notice?.textContent).toContain("Check the values below and save them.");
  expect(notice?.textContent).toContain("Fields: mode.");
  expect(screen.getByText("Save to repair the policy.")).toBeTruthy();
  // There is no change to discard.
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(SHOWN_POLICY, 2));

  // The refresh after the save brings a valid policy.
  view.rerender(<AdminPiiProtectionSection {...props} value={SHOWN_POLICY} revision={3} health={OK_HEALTH} savedMessage="PII protection settings saved." />);
  expect(screen.queryByText(text)).toBeNull();
  expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  expect(screen.getByText("PII protection settings saved.")).toBeTruthy();
});

it("shows no notice and no save for a valid policy", () => {
  render(<AdminPiiProtectionSection busy={false} error={null} savedMessage={null} onSave={vi.fn()} value={SHOWN_POLICY} health={OK_HEALTH} />);
  expect(screen.queryByText(/not valid/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
});

// The server shows a stored policy that is on with mode Off as Block (resolvePiiPolicy).
const OFF_WHILE_ON_HEALTH = { state: "error" as const, reasons: ["mode_off_while_enabled"], fields: ["mode"] };

it("keeps protection on in a repair save with no change, and Off is an explicit choice", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: false }));
  render(<AdminPiiProtectionSection busy={false} error={null} savedMessage={null} onSave={onSave} value={SHOWN_POLICY} revision={5} health={OFF_WHILE_ON_HEALTH} />);
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(SHOWN_POLICY, 5));

  fireEvent.click(screen.getByRole("combobox", { name: "Protection mode" }));
  fireEvent.click(await screen.findByRole("option", { name: "Off" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ ...SHOWN_POLICY, enabled: false, mode: "off" }, 5));
});

it("offers Reload settings after a conflict on a repair save with no change", async () => {
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: false }));
  const props = { busy: false, savedMessage: null, onSave, health: OFF_WHILE_ON_HEALTH };
  const message = "These settings changed in another session. Your changes are not saved. Reload to see the current settings.";
  const view = render(<AdminPiiProtectionSection {...props} value={SHOWN_POLICY} revision={2} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  // The failed save read the settings again. They still need a repair.
  const newer = { ...SHOWN_POLICY, rawRetention: "admin_only" as const };
  view.rerender(<AdminPiiProtectionSection {...props} value={newer} revision={3} error={message} conflict />);
  expect(screen.getByText(message)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  expect(screen.queryByText(message)).toBeNull();
  expect(screen.getByText("Save to repair the policy.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(newer, 3));
});

it("shows the saved message after a repair save when the refresh still has the old health", async () => {
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: true, revision: 3 }));
  render(<AdminPiiProtectionSection busy={false} error={null} savedMessage="PII protection settings saved." onSave={onSave} value={SHOWN_POLICY} revision={2} health={OFF_WHILE_ON_HEALTH} />);
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
  // No refresh arrives. The props still have the old health.
  expect(await screen.findByText("PII protection settings saved.")).toBeTruthy();
  expect(screen.queryByText("Save to repair the policy.")).toBeNull();
  // The repair is complete: no notice and no second save that would conflict.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save policy" })).toBeNull();
});

it("does not show the saved mode of a policy that needs a repair", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  render(<AdminPiiProtectionSection busy={false} error={null} savedMessage={null} onSave={vi.fn()} value={SHOWN_POLICY} revision={5} health={OFF_WHILE_ON_HEALTH} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Protection mode" }));
  fireEvent.click(await screen.findByRole("option", { name: "Detect" }));
  // The shown Block is a repair value, not the stored state.
  expect(screen.queryByText(/Saved mode:/)).toBeNull();
});

it("saves enabled as shown, also when the value has mode Off", async () => {
  const onSave = vi.fn(async (): Promise<PiiSaveResult> => ({ ok: false }));
  const offWhileOn = { ...SHOWN_POLICY, mode: "off" as const };
  render(<AdminPiiProtectionSection busy={false} error={null} savedMessage={null} onSave={onSave} value={offWhileOn} revision={5} health={OFF_WHILE_ON_HEALTH} />);
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
  // The form never turns protection off by itself.
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(offWhileOn, 5));
});

it("keeps Cancel for an edit while the policy needs a repair", () => {
  render(<AdminPiiProtectionSection busy={false} error={null} savedMessage={null} onSave={vi.fn()} value={SHOWN_POLICY} health={{ state: "error", reasons: [], fields: [] }} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Direct uploads" }));
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(uploadsBox().checked).toBe(true);
  expect(screen.getByRole("button", { name: "Save policy" })).toBeTruthy();
});

it("blocks repeated form submits while its save is pending, without waiting for busy props", async () => {
  let resolve!: (result: PiiSaveResult) => void;
  const onSave = vi.fn(() => new Promise<PiiSaveResult>(done => { resolve = done; }));
  renderSection(DEFAULT_PII_PROTECTION, onSave);
  fireEvent.click(uploadsBox());
  const button = screen.getByRole("button", { name: "Save changes" });
  const form = button.closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(onSave).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Saving..." }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { resolve({ ok: false }); });
  fireEvent.submit(form);
  expect(onSave).toHaveBeenCalledTimes(2);
  await act(async () => { resolve({ ok: false }); });
});

it("keeps a later draft and focus when an earlier save finishes, then uses its returned revision", async () => {
  let resolve!: (result: PiiSaveResult) => void;
  const onSave = vi.fn(() => new Promise<PiiSaveResult>(done => { resolve = done; }));
  render(<AdminPiiProtectionSection value={SHOWN_POLICY} revision={7} busy={false} error={null} savedMessage={null} onSave={onSave} />);
  fireEvent.click(uploadsBox());
  const saveButton = screen.getByRole("button", { name: "Save changes" });
  saveButton.focus();
  fireEvent.click(saveButton);
  fireEvent.click(screen.getByRole("button", { name: "Edit detection" }));
  const input = screen.getByRole("textbox", { name: "PII detection model" });
  input.focus();
  fireEvent.change(input, { target: { value: "fictional-later-model" } });
  await act(async () => { resolve({ ok: true, revision: 8 }); });
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("fictional-later-model");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(screen.queryByText("Saved.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ provider: expect.objectContaining({ model: "fictional-later-model" }) }), 8);
  await act(async () => { resolve({ ok: true, revision: 9 }); });
});

it("does not move focus from another control after a save with no later edit", async () => {
  let resolve!: (result: PiiSaveResult) => void;
  const onSave = vi.fn(() => new Promise<PiiSaveResult>(done => { resolve = done; }));
  const props = { busy: false, error: null, savedMessage: null, onSave };
  const view = render(<><button>Other control</button><AdminPiiProtectionSection {...props} value={SHOWN_POLICY} revision={7} /></>);
  fireEvent.click(uploadsBox());
  const saveButton = screen.getByRole("button", { name: "Save changes" });
  saveButton.focus();
  fireEvent.click(saveButton);
  const other = screen.getByRole("button", { name: "Other control" });
  other.focus();
  view.rerender(<><button>Other control</button><AdminPiiProtectionSection {...props} value={{ ...SHOWN_POLICY, scopes: { ...SHOWN_POLICY.scopes, uploads: false } }} revision={8} /></>);
  await act(async () => { resolve({ ok: true, revision: 8 }); });
  expect(document.activeElement).toBe(other);
  expect(screen.getByText("Saved.")).toBeTruthy();
});

it("focuses the saved status when the completed save still owns focus", async () => {
  let resolve!: (result: PiiSaveResult) => void;
  const onSave = vi.fn(() => new Promise<PiiSaveResult>(done => { resolve = done; }));
  renderSection(SHOWN_POLICY, onSave);
  fireEvent.click(uploadsBox());
  const button = screen.getByRole("button", { name: "Save changes" });
  button.focus();
  fireEvent.click(button);
  await act(async () => { resolve({ ok: true, revision: 8 }); });
  expect(document.activeElement).toBe(screen.getByRole("status"));
});

it.each(["never", "admin_only", "reversible_encrypted"] as const)("saves %s retention and preserves fields outside this editor", async rawRetention => {
  const stored = { ...SHOWN_POLICY, rawRetention, extension: { enabled: true }, provider: { ...SHOWN_POLICY.provider, deploymentHint: "fictional" }, actions: { reportToAdmins: false, extensionAction: true }, detectors: { ...SHOWN_POLICY.detectors, useRulesFirst: false, extensionDetector: true } };
  const { onSave } = renderSection(stored);
  fireEvent.click(uploadsBox());
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...stored, scopes: { ...stored.scopes, uploads: false } }, undefined));
});
