// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantSettings } from "@cogniplane/shared-types";

import { TenantSettingsForm } from "./tenant-settings-form";

function makeSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    tenantId: "t-1",
    runtimeProvider: "codex",
    enabledRuntimeProviders: ["codex"],
    showEffortSelector: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
    allowCommandExecution: false,
    allowUserTokenForwarding: false,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor",
    developerInstructions: null,
    enabledToolIds: [],
    enabledMcpServerIds: [],
    version: 1,
    configHash: "hash-1",
    updatedAt: new Date().toISOString(),
    ...overrides
  } as TenantSettings;
}

function renderForm(settings: TenantSettings, onSave = vi.fn(async () => true)) {
  const view = render(
    <TenantSettingsForm
      settings={settings}
      saving={false}
      onSave={onSave}
      managedTools={[]}
      mcpServers={[]}
      openaiKeyConfigured={true}
      anthropicKeyConfigured={false}
    />
  );
  return { view, onSave };
}

function instructionsTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Custom system prompt") as HTMLTextAreaElement;
}

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

describe("TenantSettingsForm resync", () => {
  it("a settings refetch does not clobber in-progress edits", () => {
    const { view } = renderForm(makeSettings());

    fireEvent.change(instructionsTextarea(), { target: { value: "draft in progress" } });
    expect(instructionsTextarea().value).toBe("draft in progress");

    // Refocus refetch picks up drift from another admin: new settings object.
    view.rerender(
      <TenantSettingsForm
        settings={makeSettings({ version: 2, configHash: "hash-2", developerInstructions: "someone else's text" })}
        saving={false}
        onSave={vi.fn(async () => true)}
        managedTools={[]}
        mcpServers={[]}
        openaiKeyConfigured={true}
        anthropicKeyConfigured={false}
      />
    );

    expect(instructionsTextarea().value).toBe("draft in progress");
  });

  it("resyncs from a settings change while the form is pristine", () => {
    const { view } = renderForm(makeSettings({ developerInstructions: "old" }));
    expect(instructionsTextarea().value).toBe("old");

    view.rerender(
      <TenantSettingsForm
        settings={makeSettings({ version: 2, developerInstructions: "new from server" })}
        saving={false}
        onSave={vi.fn(async () => true)}
        managedTools={[]}
        mcpServers={[]}
        openaiKeyConfigured={true}
        anthropicKeyConfigured={false}
      />
    );

    expect(instructionsTextarea().value).toBe("new from server");
  });

  it("a successful save clears the dirty state so the canonical settings resync", async () => {
    const onSave = vi.fn(async () => true);
    const { view } = renderForm(makeSettings(), onSave);

    fireEvent.change(instructionsTextarea(), { target: { value: "  my instructions  " } });
    fireEvent.submit(instructionsTextarea().closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ developerInstructions: "my instructions" })
    );

    // The mutation already wrote the canonical row to the cache; the parent
    // re-renders with it and the now-pristine form resyncs.
    view.rerender(
      <TenantSettingsForm
        settings={makeSettings({ version: 2, developerInstructions: "my instructions" })}
        saving={false}
        onSave={onSave}
        managedTools={[]}
        mcpServers={[]}
        openaiKeyConfigured={true}
        anthropicKeyConfigured={false}
      />
    );

    expect(instructionsTextarea().value).toBe("my instructions");
  });

  it("a failed save keeps the edits dirty so a refetch cannot wipe them", async () => {
    const onSave = vi.fn(async () => false);
    const { view } = renderForm(makeSettings(), onSave);

    fireEvent.change(instructionsTextarea(), { target: { value: "unsaved edits" } });
    fireEvent.submit(instructionsTextarea().closest("form")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    view.rerender(
      <TenantSettingsForm
        settings={makeSettings({ version: 3, developerInstructions: "server drift" })}
        saving={false}
        onSave={onSave}
        managedTools={[]}
        mcpServers={[]}
        openaiKeyConfigured={true}
        anthropicKeyConfigured={false}
      />
    );

    expect(instructionsTextarea().value).toBe("unsaved edits");
  });
});
