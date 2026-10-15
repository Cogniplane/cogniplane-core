// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminIntegrationView } from "@cogniplane/shared-types";

import { AdminIntegrationPane } from "./admin-integration-pane";

afterEach(cleanup);

const base: AdminIntegrationView = {
  id: "notion", name: "Notion", description: "Short text.", longDescription: "", logoSlug: "notion",
  status: "available", category: "Knowledge", readToolIds: [], writeToolIds: [], configMode: "none",
  readsEnabled: false, writesEnabled: false, hasConfig: false, configSummary: {}, updatedAt: null,
  updatedBy: null, platformConfigured: true, platformConfigMessage: null
};

function renderPane(integration: Partial<AdminIntegrationView> = {}) {
  const onClose = vi.fn();
  render(<AdminIntegrationPane
    integration={{ ...base, ...integration }} busy={false} error={null} onClose={onClose}
    onSaveConfig={vi.fn(async () => undefined)} onClearConfig={vi.fn(async () => undefined)}
  />);
  return { onClose };
}

it("prefers the long description and lists read and write tools", () => {
  renderPane({ longDescription: "Long text.", readToolIds: ["notion_search"], writeToolIds: ["notion_create_page"] });

  expect(screen.getByRole("dialog", { name: "Notion" })).toBeTruthy();
  expect(screen.getByText("Long text.")).toBeTruthy();
  expect(screen.queryByText("Short text.")).toBeNull();
  expect(screen.getByText("notion_search")).toBeTruthy();
  expect(screen.getByText("notion_create_page")).toBeTruthy();
});

it("omits the tools section when the integration has no tools, and the docs link without a URL", () => {
  renderPane();

  expect(screen.getByText("Short text.")).toBeTruthy();
  expect(screen.queryByText("What this enables")).toBeNull();
  expect(screen.queryByText("Write tools")).toBeNull();
  expect(screen.queryByRole("link", { name: "Learn more →" })).toBeNull();
});

it("lists only the kind of tools the integration has", () => {
  renderPane({ readToolIds: ["notion_search"] });

  expect(screen.getByText("Read tools")).toBeTruthy();
  expect(screen.queryByText("Write tools")).toBeNull();
});

const panels: [string, Partial<AdminIntegrationView>, RegExp, RegExp[]][] = [
  // A planned integration must not offer configuration before it ships.
  ["a planned integration", { status: "coming_soon", configMode: "oauth_app" }, /This integration is on the roadmap/, [/OAuth application/, /Platform configuration/]],
  ["an OAuth app", { configMode: "oauth_app", configFields: [] }, /OAuth application/, [/on the roadmap/, /Platform configuration/]],
  ["a platform-configured integration", { configMode: "none" }, /Platform configuration/, [/on the roadmap/, /OAuth application/]]
];

it.each(panels)("shows only the configuration panel for %s", (_case, overrides, shown, hidden) => {
  renderPane(overrides);

  expect(screen.getByText(shown)).toBeTruthy();
  for (const panel of hidden) expect(screen.queryByText(panel)).toBeNull();
});

it("links the docs and closes on Escape", () => {
  const { onClose } = renderPane({ docsUrl: "https://example.com/docs" });

  expect(screen.getByRole("link", { name: "Learn more →" }).getAttribute("href")).toBe("https://example.com/docs");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
