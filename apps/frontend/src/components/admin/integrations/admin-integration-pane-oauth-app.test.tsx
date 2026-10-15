// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminIntegrationView } from "@cogniplane/shared-types";

import { AdminIntegrationPaneOauthApp } from "./admin-integration-pane-oauth-app";

afterEach(cleanup);

const base: AdminIntegrationView = {
  id: "sharepoint", name: "SharePoint", description: "", longDescription: "", logoSlug: "sharepoint",
  status: "available", category: "files", readToolIds: [], writeToolIds: [],
  configMode: "oauth_app", readsEnabled: false, writesEnabled: false, hasConfig: false,
  configSummary: {}, updatedAt: null, updatedBy: null, platformConfigured: false, platformConfigMessage: null,
  configFields: [
    { key: "clientId", label: "Client ID", type: "text", required: true, helpText: "From the app registration." },
    { key: "clientSecret", label: "Client secret", type: "password", required: true },
    { key: "authority", label: "Authority URL", type: "url", required: false }
  ]
};

function renderPane(integration: Partial<AdminIntegrationView> = {}, busy = false) {
  const onSave = vi.fn(async () => undefined);
  const onClear = vi.fn(async () => undefined);
  const view = render(<AdminIntegrationPaneOauthApp integration={{ ...base, ...integration }} busy={busy} error={null} onSave={onSave} onClear={onClear} />);
  return { ...view, onSave, onClear };
}

const input = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

it("asks for credentials on a new integration, marks required fields, and saves what was typed", async () => {
  const { onSave } = renderPane();

  expect(screen.getByText(/Provide the credentials/)).toBeTruthy();
  expect(screen.getByText("Client ID *")).toBeTruthy();
  expect(screen.getByText("Authority URL")).toBeTruthy();
  expect(screen.getByText("From the app registration.")).toBeTruthy();
  expect([input(/Client ID/).type, input(/Client secret/).type, input(/Authority URL/).type]).toEqual(["text", "password", "url"]);
  expect(input(/Client secret/).placeholder).toBe("");
  expect(screen.queryByRole("button", { name: "Clear configuration" })).toBeNull();

  fireEvent.change(input(/Client ID/), { target: { value: "app-1" } });
  fireEvent.change(input(/Client secret/), { target: { value: "s3cret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ clientId: "app-1", clientSecret: "s3cret", authority: "" }));
});

it("fills saved values but never the secret, and masks the saved secret", () => {
  const { onClear } = renderPane({
    hasConfig: true,
    configSummary: { clientId: "app-1", clientSecret: "set" },
    updatedBy: "admin@example.com"
  });

  expect(screen.getByText("Configured")).toBeTruthy();
  expect(screen.getByText(/by admin@example.com/)).toBeTruthy();
  expect(input(/Client ID/).value).toBe("app-1");
  expect(input(/Client secret/).value).toBe("");
  expect(input(/Client secret/).placeholder).toBe("••••••••");
  expect(screen.getByRole("button", { name: "Update configuration" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Clear configuration" }));
  expect(onClear).toHaveBeenCalledTimes(1);
});

it("masks an empty secret field while a configuration exists, and unmasks it once typed into", () => {
  renderPane({ hasConfig: true, configSummary: { clientId: "app-1" } });

  expect(input(/Client secret/).placeholder).toBe("••••••••");
  fireEvent.change(input(/Client secret/), { target: { value: "new" } });
  expect(input(/Client secret/).placeholder).toBe("");
});

it("resyncs the form when the saved integration changes", () => {
  const { rerender, onSave, onClear } = renderPane({ hasConfig: true, configSummary: { clientId: "app-1" }, updatedAt: "2026-10-01T00:00:00.000Z" });
  fireEvent.change(input(/Client ID/), { target: { value: "draft" } });

  rerender(<AdminIntegrationPaneOauthApp
    integration={{ ...base, hasConfig: true, configSummary: { clientId: "app-2" }, updatedAt: "2026-10-02T00:00:00.000Z" }}
    busy={false} error={null} onSave={onSave} onClear={onClear}
  />);

  expect(input(/Client ID/).value).toBe("app-2");
});

it("locks the form while saving", () => {
  renderPane({ hasConfig: true }, true);

  expect(input(/Client ID/).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Saving..." }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Clear configuration" }) as HTMLButtonElement).disabled).toBe(true);
});
