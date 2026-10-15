"use client";

import { ConnectedAccountRow } from "../../../components/connected-account-row";
import { useEnabledSettingsSections } from "../../../hooks/use-enabled-settings-sections";
import { useGithubConnection } from "../../../hooks/use-github-connection";
import { useJiraConnection } from "../../../hooks/use-jira-connection";
import { useNotionConnection } from "../../../hooks/use-notion-connection";
import { useAuth } from "../../../lib/auth-context";
import { MemberMcpAccounts } from "../../../components/member-mcp-accounts";

function GithubAccountRow() {
  const { status, isLoading, busyKey, error, statusError, connect, reload } = useGithubConnection();
  return (
    <ConnectedAccountRow
      service="GitHub"
      slug="github"
      description="Repositories and pull requests"
      identity={status?.userConnection?.githubLogin ?? null}
      configured={status?.configured === true && status.tenantEnabled !== false}
      isLoading={isLoading}
      busyKey={busyKey}
      error={error}
      statusError={statusError}
      detailsHref="/settings/github"
      onConnect={() => void connect()}
      onRetry={() => void reload()}
    />
  );
}

function NotionAccountRow() {
  const { status, isLoading, busyKey, error, statusError, connect, reload } = useNotionConnection();
  const user = status?.userConnection;
  const identity = user
    ? [user.notionOwnerName ?? user.notionOwnerEmail, user.notionWorkspaceName]
        .filter(Boolean)
        .join(" · ") || "Notion account"
    : null;
  return (
    <ConnectedAccountRow
      service="Notion"
      slug="notion"
      description="Pages and databases in your workspace"
      identity={identity}
      configured={status?.configured === true && status.tenantEnabled !== false}
      isLoading={isLoading}
      busyKey={busyKey}
      error={error}
      statusError={statusError}
      detailsHref="/settings/notion"
      onConnect={() => void connect()}
      onRetry={() => void reload()}
    />
  );
}

function JiraAccountRow() {
  const { status, isLoading, busyKey, error, statusError, connect, reload } = useJiraConnection();
  const user = status?.userConnection;
  return (
    <ConnectedAccountRow
      service="Jira"
      slug="jira"
      description="Read-only issue search and history"
      identity={user ? [user.accountName, user.site.name].filter(Boolean).join(" · ") : null}
      // Jira has no write tools, and authorization requires reads.
      configured={status?.configured === true && status.tenantReadsEnabled === true}
      isLoading={isLoading}
      busyKey={busyKey}
      error={error}
      statusError={statusError}
      detailsHref="/settings/jira"
      onConnect={() => void connect()}
      onRetry={() => void reload()}
    />
  );
}

const coreRows: Record<string, () => React.JSX.Element> = {
  github: GithubAccountRow,
  notion: NotionAccountRow,
  jira: JiraAccountRow
};

export default function ConnectedAccountsPage() {
  const { user } = useAuth();
  const { liveSections, isLoading, error, retry } = useEnabledSettingsSections();
  const accounts = liveSections.filter((section) => section.kind === "integration");

  return (
    <section id="connections" className="pt-5">
      <p className="mb-5 max-w-2xl text-sm text-on-surface-variant">
        Connect your own account for each service you use. Your organization controls which
        services are available; enabling a service does not connect your account.
      </p>
      {error ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-danger">{error}</p>
          <button type="button" onClick={retry} className="text-sm font-medium text-on-surface underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-primary">Retry</button>
        </div>
      ) : null}
      {isLoading ? (
        <p role="status" className="text-sm text-on-surface-variant">Loading available services…</p>
      ) : accounts.length > 0 ? (
        <ul className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
          {accounts.map((account) => {
            const Row = account.accountRow ?? coreRows[account.id];
            return Row ? <Row key={account.id} /> : null;
          })}
        </ul>
      ) : !error ? (
        <p className="rounded-xl border border-outline-variant bg-surface-container-lowest p-6 text-sm text-on-surface-variant">
          No built-in account services are enabled for your organization.
        </p>
      ) : null}
      {user ? <MemberMcpAccounts key={`${user.tenantId}:${user.userId}`}
        expectedScope={{ tenantId: user.tenantId, userId: user.userId }} /> : null}
    </section>
  );
}
