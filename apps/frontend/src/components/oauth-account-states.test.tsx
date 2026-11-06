// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GithubConnectionStatus, NotionConnectionStatus, JiraConnectionStatus } from "@cogniplane/shared-types";
import { connectionDates as dates, describeConnectionAccountStates, type ConnectionStateCase } from "../test-helpers/oauth-account-states";
import { GithubConnectionSection } from "./github-connection-section";
import { NotionConnectionSection } from "./notion-connection-section";
import { JiraConnectionSection } from "./jira-connection-section";

const github: GithubConnectionStatus = { configured: true, tenantEnabled: true, userConnection: { ...dates, githubUserId: "synthetic-github-user", githubLogin: "sample-member", githubName: null, githubEmail: null, githubAvatarUrl: null, scopes: [], allowedRepositories: [] } };
const notion: NotionConnectionStatus = { configured: true, tenantEnabled: true, userConnection: { ...dates, notionUserId: "synthetic-notion-user", notionWorkspaceId: "synthetic-workspace", notionWorkspaceName: "Research", notionWorkspaceIcon: null, notionOwnerName: "Sample member", notionOwnerEmail: "sample@example.test", scopes: [] } };
const jira: JiraConnectionStatus = { configured: true, tenantReadsEnabled: true, authorizationStarted: true, cleanupPending: false, userConnection: { ...dates, accountId: "synthetic-jira-account", accountName: null, site: { siteId: "synthetic-jira-site", name: "Research", url: "https://sample.example.test" } } };
const cases: ConnectionStateCase[] = [
  { provider: "GitHub", identity: "Authorized as sample-member", mount: (props, c) => <GithubConnectionSection {...props} {...c} status={c.unknown ? null : { ...github, tenantEnabled: !c.disabled, userConnection: { ...github.userConnection!, suspended: c.suspended ?? false } }} repositorySelection={{ repositories: [], truncated: false, isLoading: false, loadError: null, isSaving: false, saveError: null, saved: false, onReload: vi.fn(), onSave: vi.fn() }} /> },
  { provider: "Notion", identity: "Connected as Sample member in Research", mount: (props, c) => <NotionConnectionSection {...props} {...c} status={c.unknown ? null : { ...notion, tenantEnabled: !c.disabled, userConnection: { ...notion.userConnection!, suspended: c.suspended ?? false } }} /> },
  { provider: "Jira", identity: "Reading Research", mount: (props, c) => <JiraConnectionSection {...props} {...c} status={c.unknown ? null : { ...jira, tenantReadsEnabled: !c.disabled, userConnection: { ...jira.userConnection!, suspended: c.suspended ?? false } }} accounts={[]} accountsLoading={false} accountsError={null} isSaving={false} onReloadAccounts={vi.fn()} onLoadSites={vi.fn()} onSelectSite={vi.fn()} /> }
];
afterEach(cleanup);

describeConnectionAccountStates(cases);

it("returns focus to the connect action after a requested disconnect removes its trigger", async () => {
  const { OAuthConnectionActions } = await import("./oauth-connection-presentation");
  const props = { busyKey: null, configured: true, connected: true, connectLabel: "Connect account", reconnectLabel: "Reconnect account", error: null, flashMessage: null, onConnect: vi.fn(), onDisconnect: vi.fn() };
  const { rerender } = render(<OAuthConnectionActions {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  rerender(<OAuthConnectionActions {...props} connected={false} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connect account" }));
});
