// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantSettings } from "@cogniplane/shared-types";

import type { TenantSettingsInput } from "../hooks/use-tenant-settings";
import { TenantSettingsForm } from "./tenant-settings-form";
import { AgentBehaviorDraftProvider } from "./agent-behavior-draft-provider";
import { makeTenantSettings as makeSettings } from "../test-helpers/tenant-settings";

type SaveFn = (input: TenantSettingsInput) => Promise<boolean>;

function formElement(settings: TenantSettings, onSave: SaveFn, extra: {
  isOwner?: boolean;
  saveError?: string | null;
  onReload?: () => void;
} = {}) {
  return (
    <TenantSettingsForm
      settings={settings}
      saving={false}
      onSave={onSave}
      saveError={extra.saveError ?? null}
      onReload={extra.onReload}
      managedTools={[]}
      modelWarning={null}
      isOwner={extra.isOwner ?? true}
    />
  );
}

function renderForm(
  settings: TenantSettings,
  onSave: SaveFn = vi.fn(async () => true),
  extra: Parameters<typeof formElement>[2] = {}
) {
  const view = render(formElement(settings, onSave, extra));
  const rerender = (next: TenantSettings, nextExtra = extra) =>
    view.rerender(formElement(next, onSave, nextExtra));
  return { view, onSave, rerender };
}

function instructionsTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Custom system prompt") as HTMLTextAreaElement;
}

function typeInstructions(value: string): void {
  fireEvent.change(instructionsTextarea(), { target: { value } });
}

function reviewButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Review changes" }) as HTMLButtonElement;
}

function openReview(): HTMLElement {
  fireEvent.click(reviewButton());
  return screen.getByRole("dialog");
}

function applyButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole("button", { name: /^(Apply|Try again|Applying)/ }) as HTMLButtonElement;
}

function changedFields(dialog: HTMLElement): string[] {
  const list = within(dialog).getByRole("list", { name: "Changed settings" });
  return within(list).getAllByRole("heading").map((heading) => heading.textContent ?? "");
}

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

describe("drafts across navigation", () => {
  function page(settings: TenantSettings, save: SaveFn, visible = true) {
    return <AgentBehaviorDraftProvider>{visible ? formElement(settings, save) : <p>History</p>}</AgentBehaviorDraftProvider>;
  }

  it("restores edits and their original version, then reviews them against newer settings", async () => {
    const original = makeSettings({ version: 4, developerInstructions: "Saved" });
    const newer = makeSettings({ version: 5, developerInstructions: "Someone else's edit", allowCommandExecution: true });
    const save = vi.fn(async () => true);
    const view = render(page(original, save));
    typeInstructions("My unfinished instructions");
    view.rerender(page(original, save, false));
    view.rerender(page(newer, save));

    expect(instructionsTextarea().value).toBe("My unfinished instructions");
    const dialog = openReview();
    expect(dialog.textContent).toContain("Organization settings changed (v5)");
    expect(dialog.textContent).toContain("Saved");
    expect(applyButton(dialog).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review my edits on v5" }));
    expect(dialog.textContent).toContain("Someone else's edit");
    fireEvent.click(applyButton(dialog));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 5, developerInstructions: "My unfinished instructions", allowCommandExecution: true
    })));
  });

  it("keeps a failed save through navigation", async () => {
    const settings = makeSettings();
    const save = vi.fn(async () => false);
    const view = render(page(settings, save));
    typeInstructions("Keep after failure");
    fireEvent.click(applyButton(openReview()));
    await screen.findByText("Could not confirm the save.");
    view.rerender(page(settings, save, false));
    view.rerender(page(settings, save));
    expect(instructionsTextarea().value).toBe("Keep after failure");
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
  });

  it("clears an explicitly discarded draft before leaving", () => {
    const settings = makeSettings({ developerInstructions: "Saved" });
    const save = vi.fn(async () => true);
    const view = render(page(settings, save));
    typeInstructions("Discard this");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    view.rerender(page(settings, save, false));
    view.rerender(page(settings, save));
    expect(instructionsTextarea().value).toBe("Saved");
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  });

  it("clears a successful save even if the form unmounted during the request", async () => {
    const settings = makeSettings({ developerInstructions: "Saved" });
    let finish!: (ok: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const view = render(page(settings, save));
    typeInstructions("Applied");
    fireEvent.click(applyButton(openReview()));
    view.rerender(page(settings, save, false));
    await act(async () => { finish(true); });
    // A later admin change must not be mistaken for a conflict with an already saved draft.
    view.rerender(page(makeSettings({ version: 3, developerInstructions: "Later saved text" }), save));
    expect(instructionsTextarea().value).toBe("Later saved text");
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  });
});

describe("review before apply", () => {
  it("does not save until the administrator applies the reviewed changes", async () => {
    const { onSave } = renderForm(makeSettings());
    typeInstructions("Use plain language.");
    fireEvent.submit(instructionsTextarea().closest("form")!);
    expect(onSave).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Review 1 change" })).toBeTruthy();
    fireEvent.click(applyButton(dialog));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 1,
      developerInstructions: "Use plain language."
    }));
  });

  it("lists each changed field with its old and new value and effect", () => {
    renderForm(makeSettings({ developerInstructions: "Old text", approvalPolicy: "on-request" }));
    fireEvent.click(screen.getByLabelText(/Auto-approve read-only tools/));
    fireEvent.click(screen.getByLabelText(/Allow command execution/));
    typeInstructions("New text");

    const dialog = openReview();
    expect(changedFields(dialog)).toEqual([
      "Auto-approve read-only tools",
      "Allow command execution",
      "Organization instructions"
    ]);
    const commands = within(dialog).getByText("Allow command execution").closest("li")!;
    expect(within(commands).getByText("Off")).toBeTruthy();
    expect(within(commands).getByText("On")).toBeTruthy();
    expect(within(commands).getByText("Widens access")).toBeTruthy();
    expect(within(dialog).getByText("Old text")).toBeTruthy();
    expect(within(dialog).getByText("New text")).toBeTruthy();
    expect(within(dialog).getByText(/Projects set to manual approval keep asking/)).toBeTruthy();
  });

  it("warns when commands would run without approval", () => {
    renderForm(makeSettings({ approvalPolicy: "never" }));
    fireEvent.click(screen.getByLabelText(/Allow command execution/));
    expect(within(openReview()).getByRole("note").textContent)
      .toContain("All members' agents can run shell commands without approval.");
  });

  it("does not count edits that save the same value", () => {
    renderForm(makeSettings({ developerInstructions: "Saved", approvalPolicy: "on-request" }));
    typeInstructions("  Saved  ");
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
    fireEvent.click(screen.getByLabelText(/Auto-approve read-only tools/));
    fireEvent.click(screen.getByLabelText(/Auto-approve read-only tools/));
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("going back from the review keeps the draft", () => {
    const { onSave } = renderForm(makeSettings({ developerInstructions: "Saved" }));
    typeInstructions("Draft");
    fireEvent.click(within(openReview()).getByRole("button", { name: "Back to editing" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(instructionsTextarea().value).toBe("Draft");
    expect(screen.getByText("1 unsaved change")).toBeTruthy();

    fireEvent.keyDown(openReview(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(instructionsTextarea().value).toBe("Draft");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("focuses the safe action when the review opens", () => {
    renderForm(makeSettings());
    typeInstructions("Draft");
    const dialog = openReview();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Back to editing" }));
  });

  it("returns focus to Review changes when the review closes with Back or Escape", async () => {
    renderForm(makeSettings());
    typeInstructions("Draft");

    fireEvent.click(within(openReview()).getByRole("button", { name: "Back to editing" }));
    await waitFor(() => expect(document.activeElement).toBe(reviewButton()));

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(openReview(), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(reviewButton()));
  });

  it("moves focus to the save status when nothing is left to review", async () => {
    const { rerender } = renderForm(makeSettings());
    typeInstructions("Saved text");
    fireEvent.click(applyButton(openReview()));
    rerender(makeSettings({ version: 2, developerInstructions: "Saved text" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
    expect(screen.getByRole("status").textContent).toMatch(/Saved as v2/);
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  });

  it("discard restores the saved settings", () => {
    renderForm(makeSettings({ developerInstructions: "Saved instructions" }));
    typeInstructions("Draft");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(instructionsTextarea().value).toBe("Saved instructions");
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });
});

describe("apply", () => {
  it("shows a failed save in the review and retries with the same draft", async () => {
    const onSave = vi.fn<SaveFn>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onReload = vi.fn();
    const { rerender } = renderForm(makeSettings(), onSave, { onReload });
    typeInstructions("Keep me");
    fireEvent.click(applyButton(openReview()));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    rerender(makeSettings(), { onReload, saveError: "Network unavailable." });

    const dialog = screen.getByRole("dialog");
    const alert = within(dialog).getByRole("alert");
    // A lost response can follow a write, so the copy does not claim that nothing was saved.
    expect(alert.textContent).toContain("Could not confirm the save.");
    expect(alert.textContent).toContain("Network unavailable.");
    expect(alert.textContent).not.toMatch(/not saved/i);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(instructionsTextarea().value).toBe("Keep me");

    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toEqual(onSave.mock.calls[0]?.[0]);
  });

  it("applies once while the save is pending and cannot be dismissed", async () => {
    let resolve!: (ok: boolean) => void;
    const onSave = vi.fn<SaveFn>(() => new Promise((done) => { resolve = done; }));
    renderForm(makeSettings(), onSave);
    typeInstructions("Once");
    const dialog = openReview();
    fireEvent.click(applyButton(dialog));
    fireEvent.click(applyButton(dialog));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(applyButton(dialog).textContent).toBe("Applying…");
    expect(applyButton(dialog).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Back to editing" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => resolve(true));
  });

  it("keeps an edit made during the save without sending it", async () => {
    let resolve!: (ok: boolean) => void;
    const onSave = vi.fn<SaveFn>(() => new Promise((done) => { resolve = done; }));
    const { rerender } = renderForm(makeSettings(), onSave);
    typeInstructions("Reviewed");
    fireEvent.click(applyButton(openReview()));
    typeInstructions("Typed later");
    await act(async () => resolve(true));
    rerender(makeSettings({ version: 2, developerInstructions: "Reviewed" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ developerInstructions: "Reviewed" }));
    expect(instructionsTextarea().value).toBe("Typed later");
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
  });

  it("confirms a successful save and resyncs to the saved row", async () => {
    const { onSave, rerender } = renderForm(makeSettings());
    typeInstructions("  my instructions  ");
    fireEvent.click(applyButton(openReview()));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ developerInstructions: "my instructions" }));
    rerender(makeSettings({ version: 2, developerInstructions: "my instructions" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(instructionsTextarea().value).toBe("my instructions");
    expect(screen.getByText(/Saved as v2/)).toBeTruthy();
  });
});

describe("baseline and concurrent changes", () => {
  it("a background refetch does not replace edits or their version", async () => {
    const { onSave, rerender } = renderForm(makeSettings({ version: 4 }));
    typeInstructions("my draft");
    rerender(makeSettings({ version: 5, configHash: "hash-5", developerInstructions: "someone else's text" }));

    expect(instructionsTextarea().value).toBe("my draft");
    expect(screen.getByText("v4")).toBeTruthy();
    expect(screen.getByText(/Organization settings changed to v5 since your draft began/)).toBeTruthy();

    const dialog = openReview();
    // A newer version can come from any settings page, so the copy does not name its author.
    const alert = within(dialog).getByRole("alert");
    expect(alert.textContent).toContain("Organization settings changed (v5) since your draft began.");
    expect(alert.textContent).not.toMatch(/another administrator|nothing from your draft/i);
    expect(applyButton(dialog).disabled).toBe(true);
    fireEvent.click(applyButton(dialog));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("puts my edits on the latest settings only when asked", async () => {
    const { onSave, rerender } = renderForm(makeSettings({ version: 4, webSearchMode: "live" }));
    typeInstructions("my draft");
    fireEvent.click(screen.getByLabelText(/Auto-approve read-only tools/));
    rerender(makeSettings({ version: 5, webSearchMode: "disabled", autoApproveReadOnlyTools: false, developerInstructions: "theirs" }));

    const dialog = openReview();
    expect(within(dialog).getByRole("alert").textContent).toContain("Organization settings changed (v5)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review my edits on v5" }));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(changedFields(dialog)).toEqual(["Organization instructions"]);
    fireEvent.click(applyButton(dialog));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 5,
      webSearchMode: "disabled",
      autoApproveReadOnlyTools: false,
      developerInstructions: "my draft"
    }));
  });

  it("rebases silently when a newer version changed no field that the draft changed", async () => {
    const { onSave, rerender } = renderForm(makeSettings({ version: 4 }));
    typeInstructions("my draft");
    // Another page saved: the models and one Agent behavior field that this draft did not edit.
    rerender(makeSettings({ version: 5, enabledModelIds: ["deepagents/claude-sonnet-5"], autoApproveReadOnlyTools: false }));

    expect(instructionsTextarea().value).toBe("my draft");
    expect(screen.getByText("v5")).toBeTruthy();
    expect(screen.queryByText(/Organization settings changed/)).toBeNull();
    const dialog = openReview();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(changedFields(dialog)).toEqual(["Organization instructions"]);
    fireEvent.click(applyButton(dialog));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 5,
      autoApproveReadOnlyTools: false,
      developerInstructions: "my draft"
    }));
  });

  it("lets a rejected save retry on the newer version when no edited field changed", async () => {
    const onSave = vi.fn<SaveFn>().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { rerender } = renderForm(makeSettings({ version: 4 }), onSave);
    typeInstructions("my draft");
    fireEvent.click(applyButton(openReview()));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    rerender(makeSettings({ version: 5, policyEnforcementMode: "enforce" }), { saveError: "Settings changed." });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Review my edits on v5" })).toBeNull();
    fireEvent.click(applyButton(dialog));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 5, developerInstructions: "my draft" }));
  });

  it("a rejected save that reveals a newer version offers review, not retry", async () => {
    const onSave = vi.fn<SaveFn>(async () => false);
    const { rerender } = renderForm(makeSettings({ version: 4 }), onSave);
    typeInstructions("my draft");
    fireEvent.click(applyButton(openReview()));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    rerender(makeSettings({ version: 5, developerInstructions: "theirs" }), { saveError: "Settings changed." });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Review my edits on v5" })).toBeTruthy();
    expect(applyButton(dialog).disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "Discard my edits" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(instructionsTextarea().value).toBe("theirs");
    expect(screen.getByText("v5")).toBeTruthy();
  });

  it("a failed response followed by saved settings that match the draft does not write twice", async () => {
    const onSave = vi.fn<SaveFn>(async () => false);
    const onReload = vi.fn();
    const { rerender } = renderForm(makeSettings({ version: 4 }), onSave, { onReload });
    typeInstructions("my draft");
    fireEvent.click(applyButton(openReview()));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onReload).toHaveBeenCalledTimes(1);
    // The write persisted before the response was lost; the refetch returns it.
    rerender(makeSettings({ version: 5, developerInstructions: "my draft" }), {
      onReload,
      saveError: "Network unavailable."
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toMatch(/not saved|nothing from your draft|another administrator/i);
    expect(within(dialog).getByRole("alert").textContent).toContain("Organization settings changed (v5)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review my edits on v5" }));

    expect(within(dialog).getByRole("heading", { name: "No changes to apply" })).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(applyButton(dialog).disabled).toBe(true);
    fireEvent.click(applyButton(dialog));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(instructionsTextarea().value).toBe("my draft");
    expect(screen.getByText("v5")).toBeTruthy();
  });

  it("follows newer settings while the form has no changes", () => {
    const { rerender } = renderForm(makeSettings({ developerInstructions: "old" }));
    rerender(makeSettings({ version: 2, developerInstructions: "new from server" }));
    expect(instructionsTextarea().value).toBe("new from server");
  });

  it("ignores an older settings response", () => {
    const { rerender } = renderForm(makeSettings({ version: 3, developerInstructions: "current" }));
    rerender(makeSettings({ version: 2, developerInstructions: "stale" }));
    expect(instructionsTextarea().value).toBe("current");
    expect(screen.getByText("v3")).toBeTruthy();
  });
});

describe("Agent behavior scope", () => {
  it("disables owner-only execution settings for admins", () => {
    renderForm(makeSettings({ approvalPolicy: "on-request" }), vi.fn(async () => true), { isOwner: false });

    expect((screen.getByLabelText(/Allow command execution/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Auto-approve read-only tools/) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getAllByText(/Owner role required/)).toHaveLength(1);
  });

  it("saves behavior without resubmitting connection, model, or policy settings", async () => {
    const onSave = vi.fn<SaveFn>(async () => true);
    renderForm(makeSettings(), onSave);
    typeInstructions("Use plain language.");
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    fireEvent.click(applyButton(openReview()));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("showEffortSelector");
    expect(payload).not.toHaveProperty("enabledMcpServerIds");
    expect(payload).not.toHaveProperty("policyEnforcementMode");
    expect(payload).not.toHaveProperty("enabledProviders");
  });

  it("shows only settings the runtime uses and keeps a saved granular policy", () => {
    const { onSave } = renderForm(makeSettings({ approvalPolicy: { granular: { sandbox_approval: true, mcp_elicitations: false, rules: false, request_permissions: false, skill_approval: false } } as never }));
    expect(screen.queryByText(/Web search/)).toBeNull();
    expect(screen.queryByText(/Approval reviewer/)).toBeNull();
    expect(screen.getByRole("combobox", { name: "Approval mode" }).textContent).toBe("Require approval");
    expect(screen.getByText(/The agent asks before it acts\./)).toBeTruthy();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("states the saved policy mode, not the one the draft started from", () => {
    const { rerender } = renderForm(makeSettings({ version: 4, policyEnforcementMode: "monitor" }));
    typeInstructions("my draft");
    rerender(makeSettings({ version: 5, policyEnforcementMode: "enforce", developerInstructions: "theirs" }));
    // The overlapping edit keeps the old baseline, but the row states the saved mode.
    expect(screen.getByText("v4")).toBeTruthy();
    expect(screen.getByText(/Policy rules also block actions or ask for approval\./)).toBeTruthy();
  });

  it("does not offer read-only auto-approval when approval is off", () => {
    renderForm(makeSettings({ approvalPolicy: "never" }));
    expect((screen.getByLabelText(/Auto-approve read-only tools/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/The agent acts without asking\./)).toBeTruthy();
  });

  it("limits instructions to the stored maximum", () => {
    renderForm(makeSettings());
    typeInstructions("my draft");
    expect(instructionsTextarea().maxLength).toBe(4000);
    expect(screen.getByText("8/4000 characters")).toBeTruthy();
  });
});

describe("sandbox network access", () => {
  function hostsTextarea(): HTMLTextAreaElement {
    return screen.getByLabelText("Approved hosts") as HTMLTextAreaElement;
  }
  function typeHosts(value: string): void {
    fireEvent.change(hostsTextarea(), { target: { value } });
  }

  it("says that no hosts means no network, and how many are approved otherwise", () => {
    const view = renderForm(makeSettings({ allowCommandExecution: true }));
    expect(screen.getByText("No hosts approved. Commands in the sandbox cannot reach any network.")).toBeTruthy();
    view.view.unmount();

    renderForm(makeSettings({ allowCommandExecution: true, approvedSandboxEgressDomains: ["pypi.org"] }));
    expect(screen.getByText("1 host approved. Commands in the sandbox can reach only this host.")).toBeTruthy();
    cleanup();

    renderForm(makeSettings({ allowCommandExecution: true, approvedSandboxEgressDomains: ["pypi.org", "*.example.com"] }));
    expect(screen.getByText("2 hosts approved. Commands in the sandbox can reach only these hosts.")).toBeTruthy();
    expect((hostsTextarea()).value).toBe("*.example.com\npypi.org");
  });

  it("says that no sandbox runs while command execution is off", () => {
    renderForm(makeSettings({ allowCommandExecution: false }));
    expect(screen.getByText(/Command execution is off, so no sandbox runs yet\./)).toBeTruthy();
  });

  it("shows approved hosts as a reviewed change that widens access, then saves the checked list", async () => {
    const { onSave } = renderForm(makeSettings({ allowCommandExecution: true }));
    typeHosts("  PyPI.org\nfiles.pythonhosted.org\n*.Example.com\n");

    const dialog = openReview();
    expect(changedFields(dialog)).toEqual(["Sandbox network access"]);
    const item = within(dialog).getByText("Sandbox network access").closest("li")!;
    expect(within(item).getByText("Widens access")).toBeTruthy();
    expect(within(item).getByText("pypi.org")).toBeTruthy();
    expect(within(item).getByText("*.example.com")).toBeTruthy();
    expect(item.textContent).toContain("DNS lookups also work for every name");

    fireEvent.click(applyButton(dialog));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 1,
      approvedSandboxEgressDomains: ["*.example.com", "files.pythonhosted.org", "pypi.org"]
    }));
  });

  it("shows removing the last host as a change that adds a limit", () => {
    renderForm(makeSettings({ allowCommandExecution: true, approvedSandboxEgressDomains: ["pypi.org"] }));
    typeHosts("");
    const item = within(openReview()).getByText("Sandbox network access").closest("li")!;
    expect(within(item).getByText("Adds limits")).toBeTruthy();
    expect(item.textContent).toContain("The sandbox then has no network access.");
  });

  it("an administrator who is not an owner can approve hosts, and still cannot change command execution", async () => {
    const { onSave } = renderForm(makeSettings(), vi.fn(async () => true), { isOwner: false });
    expect((screen.getByLabelText(/Allow command execution/) as HTMLInputElement).disabled).toBe(true);
    typeHosts("pypi.org");
    fireEvent.click(applyButton(openReview()));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      approvedSandboxEgressDomains: ["pypi.org"]
    })));
  });

  it("names each host that the server would refuse, and blocks the review until they are fixed", async () => {
    const { onSave } = renderForm(makeSettings({ allowCommandExecution: true }));
    fireEvent.click(screen.getByRole("button", { name: "Edit hosts" }));
    typeHosts("pypi.org\n*.com\nhttps://example.org\n93.184.216.34");

    expect(hostsTextarea().getAttribute("aria-invalid")).toBe("true");
    const problems = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(problems.some((text) => text.startsWith('Line 2: "*.com" would approve every host under a public suffix'))).toBe(true);
    expect(problems.some((text) => text.startsWith('Line 3: "https://example.org" must be a host name only'))).toBe(true);
    expect(problems.some((text) => text.startsWith('Line 4: "93.184.216.34" is an IP address'))).toBe(true);
    // The bar still offers Discard, and says why a review is not possible.
    expect(screen.getByText(/Fix the approved sandbox hosts before you review/)).toBeTruthy();

    fireEvent.click(reviewButton());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    // The list stays open and takes focus, so that the problem is where the administrator looks.
    await waitFor(() => expect(document.activeElement).toBe(hostsTextarea()));
    expect(screen.getByRole("button", { name: "Edit hosts" }).getAttribute("aria-expanded")).toBe("true");

    typeHosts("pypi.org");
    expect(hostsTextarea().getAttribute("aria-invalid")).toBe("false");
    expect(screen.queryByText(/Fix the approved sandbox hosts/)).toBeNull();
    expect(within(openReview()).getByRole("heading", { name: "Review 1 change" })).toBeTruthy();
  });

  it("opens a closed list and focuses it when the review is refused", async () => {
    renderForm(makeSettings({ allowCommandExecution: true }));
    // The list is closed: the draft was edited before, or by a restored draft.
    typeHosts("*.com");
    expect(screen.getByRole("button", { name: "Edit hosts" }).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(reviewButton());

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit hosts" }).getAttribute("aria-expanded")).toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(hostsTextarea()));
  });

  it("refuses more hosts than one organization can approve", () => {
    renderForm(makeSettings({ allowCommandExecution: true }));
    typeHosts(Array.from({ length: 26 }, (_, i) => `host${i}.example.com`).join("\n"));
    expect(screen.getByText("Approve at most 25 hosts. This list has 26.")).toBeTruthy();
    fireEvent.click(reviewButton());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("discard restores the saved list and clears the problems", () => {
    renderForm(makeSettings({ allowCommandExecution: true, approvedSandboxEgressDomains: ["pypi.org"] }));
    typeHosts("*.com");
    expect(screen.getByText(/Fix the approved sandbox hosts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(hostsTextarea().value).toBe("pypi.org");
    expect(screen.queryByText(/Fix the approved sandbox hosts/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  });

  it("keeps another administrator's host change when my draft changed something else", () => {
    const { rerender } = renderForm(makeSettings({ version: 4, allowCommandExecution: true }));
    typeInstructions("My instructions");
    rerender(makeSettings({ version: 5, allowCommandExecution: true, approvedSandboxEgressDomains: ["pypi.org"] }));

    expect(hostsTextarea().value).toBe("pypi.org");
    expect(instructionsTextarea().value).toBe("My instructions");
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    expect(screen.queryByText(/Organization settings changed to v5/)).toBeNull();
  });

  it("reports a conflict when two administrators changed the host list", () => {
    const { rerender } = renderForm(makeSettings({ version: 4, allowCommandExecution: true }));
    typeHosts("mine.example.com");
    rerender(makeSettings({ version: 5, allowCommandExecution: true, approvedSandboxEgressDomains: ["theirs.example.com"] }));

    expect(screen.getByText(/Organization settings changed to v5 since your draft began/)).toBeTruthy();
    expect(hostsTextarea().value).toBe("mine.example.com");
  });
});
