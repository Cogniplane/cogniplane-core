// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { JiraAccountCandidate, JiraConnectionStatus, JiraSite } from "@cogniplane/shared-types";
import { JiraConnectionSection } from "./jira-connection-section";

afterEach(cleanup);

const acme = { siteId: "11111111-2222-4333-8444-555555555555", name: "Acme", url: "https://acme.atlassian.net" };
const beta = { siteId: "99999999-2222-4333-8444-555555555555", name: "Beta", url: "https://beta.atlassian.net" };
const notConnected: JiraConnectionStatus = {
  configured: true, userConnection: null, tenantReadsEnabled: true, authorizationStarted: false, cleanupPending: false
};
const connection = { accountId: "apn_1", accountName: null, site: acme, connectedAt: "2026-09-30T12:00:00Z", updatedAt: "2026-09-30T12:00:00Z" };

function mount(
  status: JiraConnectionStatus | null,
  accounts: JiraAccountCandidate[] = [],
  options: { isSaving?: boolean; onLoadSites?: (accountId: string) => Promise<JiraSite[]> } = {}
) {
  const handlers = {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onReloadAccounts: vi.fn(),
    onSelectSite: vi.fn(),
    onLoadSites: vi.fn(options.onLoadSites ?? (async () => [acme, beta]))
  };
  render(<JiraConnectionSection status={status} error={null} flashMessage={null} busyKey={null}
    accounts={accounts} accountsLoading={false} accountsError={null} isSaving={options.isSaving ?? false} {...handlers} />);
  return handlers;
}

const healthy = (accountId: string, accountName: string | null = null): JiraAccountCandidate =>
  ({ accountId, accountName, healthy: true, createdAt: null });

it("loads sites only for the account the user chooses", async () => {
  const accounts = [
    ...[1, 2, 3, 4, 5].map((n) => ({ ...healthy(`apn_sick${n}`, `sick${n}@example.test`), healthy: false })),
    healthy("apn_6", "sixth@example.test")
  ];
  const { onLoadSites, onSelectSite } = mount({ ...notConnected, authorizationStarted: true }, accounts);
  expect(screen.getByText("No Jira site selected")).toBeTruthy();
  expect(screen.getAllByText("needs reconnection")).toHaveLength(5);
  expect(onLoadSites).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Show sites for sixth@example.test" }));
  expect(onLoadSites).toHaveBeenCalledWith("apn_6");
  fireEvent.click((await screen.findAllByRole("button", { name: "Use this site" }))[1]);
  expect(onSelectSite).toHaveBeenCalledWith({ accountId: "apn_6", siteId: beta.siteId });
  // Authorized accounts exist in Pipedream, so the user can remove them.
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
});

it("shows a failed lookup as retryable, not as a broken account", async () => {
  let fail = true;
  const { onLoadSites } = mount(notConnected, [healthy("apn_1", "me@example.test")], {
    onLoadSites: async () => {
      if (fail) throw new Error("Could not list Jira sites for this account.");
      return [acme];
    }
  });
  fireEvent.click(screen.getByRole("button", { name: "Show sites for me@example.test" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not list Jira sites for this account.");
  expect(screen.queryByText(/Connect it again/)).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again to show sites for me@example.test" }));
  expect(await screen.findByText("Acme")).toBeTruthy();
  expect(onLoadSites).toHaveBeenCalledTimes(2);
});

it("marks the selected site", async () => {
  mount({ ...notConnected, userConnection: connection, authorizationStarted: true }, [healthy("apn_1")],
    { onLoadSites: async () => [acme] });
  expect(screen.getByText("Reading Acme")).toBeTruthy();
  expect(screen.getByText("selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show sites for Jira account" }));
  expect(await screen.findByText("selected")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use this site" })).toBeNull();
});

it("disables site choice and disconnect while a site is being saved", async () => {
  mount({ ...notConnected, authorizationStarted: true }, [healthy("apn_1", "me@example.test")], { isSaving: true });
  expect((screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Show sites for me@example.test" }));
  const [use] = await screen.findAllByRole("button", { name: "Use this site" });
  expect((use as HTMLButtonElement).disabled).toBe(true);
});

it("does not offer to connect when the platform is not configured", () => {
  mount({ configured: false, userConnection: null, authorizationStarted: false, cleanupPending: false });
  expect((screen.getByRole("button", { name: "Connect my Jira account" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Contact your organization administrator/)).toBeTruthy();
  expect(screen.queryByText(/PIPEDREAM_/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
});

it("keeps disconnect but not connect or site choice when the organization turns Jira off", () => {
  const { onDisconnect } = mount({
    ...notConnected, tenantReadsEnabled: false, userConnection: connection, authorizationStarted: true
  });
  expect(screen.getByText("Connected to Acme")).toBeTruthy();
  expect(screen.queryByText(/Reading/)).toBeNull();
  expect(screen.getByText(/has not enabled Jira/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Connect another Jira account" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("Jira accounts")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(onDisconnect).toHaveBeenCalled();
});

it("offers to remove an authorization without a chosen site when the organization turns Jira off", () => {
  const { onDisconnect } = mount({ ...notConnected, tenantReadsEnabled: false, authorizationStarted: true });
  expect(screen.getByText("not connected")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Connect another Jira account" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(onDisconnect).toHaveBeenCalled();
});

it("asks to retry a removal that did not finish", () => {
  mount({ ...notConnected, cleanupPending: true });
  expect(screen.getByText(/earlier removal did not finish/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
});

it("does not offer disconnect when nothing was authorized", () => {
  mount(notConnected);
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
});
