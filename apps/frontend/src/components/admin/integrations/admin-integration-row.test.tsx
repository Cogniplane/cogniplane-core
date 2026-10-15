// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminIntegrationView } from "@cogniplane/shared-types";
import { AdminIntegrationRow } from "./admin-integration-row";

afterEach(cleanup);

const github = {
  id: "github", name: "GitHub", description: "", longDescription: "", logoSlug: "github", status: "available", category: "Code",
  readToolIds: ["github_read_file"], writeToolIds: ["github_write_file"], configMode: "oauth_app", readsEnabled: false, writesEnabled: false, hasConfig: false,
  configSummary: {}, updatedAt: null, updatedBy: null, platformConfigured: true, platformConfigMessage: null
} as unknown as AdminIntegrationView;

function mount(integration: AdminIntegrationView) {
  const handlers = { onOpen: vi.fn(), onToggleReads: vi.fn(), onToggleWrites: vi.fn() };
  render(<AdminIntegrationRow integration={integration} busy={false} {...handlers} />);
  return handlers;
}

it("asks for configuration before reads or writes can turn on", () => {
  const { onOpen } = mount(github);
  expect(screen.getByText("Needs configuration.")).toBeTruthy();
  expect((screen.getByRole("switch", { name: "Reads for GitHub" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("switch", { name: "Writes for GitHub" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole("heading").textContent).toBe("GitHub");
  fireEvent.click(screen.getByRole("button", { name: "Configure GitHub" }));
  expect(onOpen).toHaveBeenCalledOnce();
});

it("toggles writes without opening the details", () => {
  const { onOpen, onToggleWrites } = mount({ ...github, hasConfig: true, readsEnabled: true });
  expect(screen.getByText("Enabled.")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Writes for GitHub" }));
  expect(onToggleWrites).toHaveBeenCalledWith(true);
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Details for GitHub" })).toBeTruthy();
});

it("does not add a second period to a platform message", () => {
  mount({ ...github, platformConfigured: false, platformConfigMessage: "Set GITHUB_APP_ID to enable GitHub." });
  expect(screen.getByText("Set GITHUB_APP_ID to enable GitHub.")).toBeTruthy();
});

it("shows no writes switch for a read-only integration", () => {
  const jira = { ...github, id: "jira", name: "Jira", writeToolIds: [], configMode: "none", readsEnabled: true } as AdminIntegrationView;
  mount(jira);
  expect(screen.getByRole("switch", { name: "Reads for Jira" })).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Writes for Jira" })).toBeNull();
});

it("keeps a writes flag that an earlier version accepted, so it can be turned off", () => {
  const jira = { ...github, id: "jira", name: "Jira", writeToolIds: [], configMode: "none", writesEnabled: true } as AdminIntegrationView;
  const { onToggleWrites } = mount(jira);
  fireEvent.click(screen.getByRole("switch", { name: "Writes for Jira" }));
  expect(onToggleWrites).toHaveBeenCalledWith(false);
});
