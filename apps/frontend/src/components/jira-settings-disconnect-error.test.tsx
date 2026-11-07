// @vitest-environment jsdom
// The server removes the local Jira connection before the Pipedream cleanup.
// When the cleanup fails, the page must show the new status, not the stale
// connection, and keep Disconnect available as the retry.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { JiraConnectionStatus } from "@cogniplane/shared-types";

const connected: JiraConnectionStatus = {
  configured: true,
  tenantReadsEnabled: true,
  authorizationStarted: true,
  cleanupPending: false,
  userConnection: {
    accountId: "apn_1",
    accountName: null,
    site: { siteId: "11111111-2222-4333-8444-555555555555", name: "Acme", url: "https://acme.atlassian.net" },
    connectedAt: "2026-09-30T12:00:00Z",
    updatedAt: "2026-09-30T12:00:00Z",
    suspended: false
  }
};

const state = vi.hoisted(() => ({ status: null as JiraConnectionStatus | null }));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("../lib/settings-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings-api")>()),
  fetchJiraConnectionStatus: async () => state.status,
  listJiraAccountCandidates: async () => [],
  deleteJiraConnection: async () => {
    state.status = { ...connected, userConnection: null, authorizationStarted: false, cleanupPending: true };
    throw new Error("Cogniplane removed your Jira connection, but some Jira accounts are still stored in Pipedream.");
  }
}));

import { JiraAccountRow, JiraSettingsDetail as SettingsJiraPage } from "./jira-settings";

afterEach(cleanup);

it("shows the removed connection and a retry after a failed Pipedream cleanup", async () => {
  state.status = connected;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SettingsJiraPage /></QueryClientProvider>);
  expect(await screen.findByText("Reading Acme")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

  expect(await screen.findByText("No Jira site selected")).toBeTruthy();
  expect(screen.queryByText("Reading Acme")).toBeNull();
  expect(screen.queryByText("https://acme.atlassian.net")).toBeNull();
  expect(screen.getByText(/some Jira accounts are still stored in Pipedream/)).toBeTruthy();
  expect(screen.getByText(/An earlier removal did not finish in Pipedream/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
});

// While suspended, the account list does not show the account name, which
// whoever authorized the account chose.
it("labels a suspended Jira connection without the account name", async () => {
  state.status = { ...connected, userConnection: { ...connected.userConnection!, accountName: "Someone", suspended: true } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ul><JiraAccountRow /></ul></QueryClientProvider>);
  expect(await screen.findByText("Suspended")).toBeTruthy();
  expect(screen.getByText(/Acme/)).toBeTruthy();
  expect(screen.queryByText(/Someone/)).toBeNull();
});
