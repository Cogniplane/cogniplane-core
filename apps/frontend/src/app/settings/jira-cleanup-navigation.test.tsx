// @vitest-environment jsdom
// Starts at Connected accounts after an administrator turned Jira off, and
// follows the Details link to the Jira page that removes the authorization.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JiraConnectionStatus, UserIntegrationView } from "@cogniplane/shared-types";

import { queryKeys } from "../../lib/query-keys";

const state = vi.hoisted(() => ({
  navigate: (_href: string) => {},
  availability: [] as UserIntegrationView[],
  availabilityError: null as Error | null,
  jiraStatus: null as JiraConnectionStatus | null,
  jiraStatusError: null as Error | null,
  fetchJiraConnectionStatus: vi.fn(async (): Promise<JiraConnectionStatus | null> => null),
  deleteJiraConnection: vi.fn(async () => undefined),
  listJiraAccountCandidates: vi.fn(async () => [])
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest} onClick={(event) => { event.preventDefault(); state.navigate(href); }}>{children}</a>
  )
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ user: null }) }));
// Jira is off unless a test adds it to the availability list.
vi.mock("../../lib/integrations-api", () => ({
  fetchIntegrationsAvailability: async () => {
    if (state.availabilityError) throw state.availabilityError;
    return state.availability;
  }
}));
vi.mock("../../lib/settings-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/settings-api")>()),
  fetchJiraConnectionStatus: state.fetchJiraConnectionStatus,
  deleteJiraConnection: state.deleteJiraConnection,
  listJiraAccountCandidates: state.listJiraAccountCandidates
}));

import ConnectedAccountsPage from "./connections/page";
import SettingsJiraPage from "./jira/page";

function App() {
  const [path, setPath] = useState("/settings/connections");
  useEffect(() => {
    state.navigate = setPath;
  }, []);
  return path === "/settings/jira" ? <SettingsJiraPage /> : <ConnectedAccountsPage />;
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  return client;
}

const jiraView: UserIntegrationView = {
  id: "jira",
  name: "Jira",
  logoSlug: "jira",
  category: "productivity",
  readsEnabled: true,
  writesEnabled: false
};

const disabled = {
  configured: true,
  userConnection: null,
  cleanupPending: false,
  tenantEnabled: false,
  tenantReadsEnabled: false,
  tenantWritesEnabled: false,
  platformConfigured: true
};

beforeEach(() => {
  vi.clearAllMocks();
  state.availability = [];
  state.availabilityError = null;
  state.jiraStatusError = null;
  state.fetchJiraConnectionStatus.mockImplementation(async () => {
    if (state.jiraStatusError) throw state.jiraStatusError;
    return state.jiraStatus;
  });
});
afterEach(cleanup);

it("reaches Jira cleanup for an authorization without a site after Jira is turned off", async () => {
  state.jiraStatus = { ...disabled, authorizationStarted: true };
  renderApp();

  expect(await screen.findByRole("heading", { name: "Jira" })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Details for Jira" }));

  expect(await screen.findByText("Jira not enabled")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(state.deleteJiraConnection).toHaveBeenCalledOnce());
  // Reads stay gated: accounts are not listed while Jira is off.
  expect(state.listJiraAccountCandidates).not.toHaveBeenCalled();
});

it("hides Jira when it is off and the member has nothing to remove", async () => {
  state.jiraStatus = { ...disabled, authorizationStarted: false };
  renderApp();
  await waitFor(() => expect(state.fetchJiraConnectionStatus).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await screen.findByText(/No built-in account services are enabled/)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Jira" })).toBeNull();
});

it("keeps Jira while its status lookup fails, and Retry hides it once the status shows nothing to remove", async () => {
  state.jiraStatusError = new Error("Network error");
  state.jiraStatus = { ...disabled, authorizationStarted: false };
  renderApp();

  const alert = await screen.findByText("Could not check your Jira connection.");
  expect(screen.getByRole("heading", { name: "Jira" })).toBeTruthy();
  expect(screen.queryByText(/No built-in account services are enabled/)).toBeNull();

  state.jiraStatusError = null;
  const calls = state.fetchJiraConnectionStatus.mock.calls.length;
  fireEvent.click(within(alert.parentElement!).getByRole("button", { name: "Retry" }));

  expect(await screen.findByText(/No built-in account services are enabled/)).toBeTruthy();
  expect(state.fetchJiraConnectionStatus.mock.calls.length).toBeGreaterThan(calls);
  expect(screen.queryByRole("heading", { name: "Jira" })).toBeNull();
  expect(screen.queryByText("Could not check your Jira connection.")).toBeNull();
});

it("reaches Jira cleanup from a failed status lookup", async () => {
  state.jiraStatusError = new Error("Network error");
  renderApp();
  await screen.findByText("Could not check your Jira connection.");

  // The lookup works again by the time the member opens the Jira page.
  state.jiraStatusError = null;
  state.jiraStatus = { ...disabled, authorizationStarted: true };
  fireEvent.click(screen.getByRole("link", { name: "Details for Jira" }));

  expect(await screen.findByText("Jira not enabled")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(state.deleteJiraConnection).toHaveBeenCalledOnce());
});

it("shows loading, not an empty result, while the Jira status lookup is pending", async () => {
  let resolve!: (status: JiraConnectionStatus) => void;
  state.fetchJiraConnectionStatus.mockImplementation(() => new Promise((done) => { resolve = done; }));
  renderApp();

  await waitFor(() => expect(state.fetchJiraConnectionStatus).toHaveBeenCalled());
  expect(screen.getByText("Loading available services…")).toBeTruthy();
  expect(screen.queryByText(/No built-in account services are enabled/)).toBeNull();

  resolve({ ...disabled, authorizationStarted: true });
  expect(await screen.findByRole("heading", { name: "Jira" })).toBeTruthy();
});

it("leaves a cached Jira status error to the Jira row after Jira is turned back on", async () => {
  state.jiraStatusError = new Error("Network error");
  const client = renderApp();
  await screen.findByText("Could not check your Jira connection.");

  state.availability = [jiraView];
  await client.invalidateQueries({ queryKey: queryKeys.settings.integrationsAvailability() });

  // The enabled Jira row reports its own status failure; settings do not.
  expect(await screen.findByText("Status unavailable")).toBeTruthy();
  expect(screen.queryByText("Could not check your Jira connection.")).toBeNull();
  expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual(["Network error"]);
});

it("does not retry a cached Jira status error while availability fails", async () => {
  state.jiraStatusError = new Error("Network error");
  const client = renderApp();
  await screen.findByText("Could not check your Jira connection.");

  state.availabilityError = new Error("Availability down");
  await client.refetchQueries({ queryKey: queryKeys.settings.integrationsAvailability() });
  const alert = await screen.findByText("Availability down");
  expect(screen.queryByText("Could not check your Jira connection.")).toBeNull();

  const calls = state.fetchJiraConnectionStatus.mock.calls.length;
  fireEvent.click(within(alert.parentElement!).getByRole("button", { name: "Retry" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.fetchJiraConnectionStatus.mock.calls.length).toBe(calls);
});
