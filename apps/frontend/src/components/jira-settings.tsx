"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { ConnectedAccountRow } from "./connected-account-row";
import { JiraConnectionSection } from "./jira-connection-section";
import { buildOAuthFlashMessage } from "./oauth-settings-page";
import { useJiraAccountSelection, useJiraConnection } from "../hooks/use-jira-connection";

export function JiraAccountRow() {
  const { status, isLoading, busyKey, error, statusError, connect, reload } = useJiraConnection();
  const user = status?.userConnection;
  return (
    <ConnectedAccountRow
      service="Jira"
      slug="jira"
      description="Read-only issue search and history"
      // While suspended the account name proves nothing: whoever authorized the account chose it.
      identity={user ? [user.suspended ? null : user.accountName, user.site.name].filter(Boolean).join(" · ") : null}
      suspended={user?.suspended === true}
      // Jira has no write tools, and authorization requires reads.
      configured={status?.configured === true && status.tenantReadsEnabled === true}
      statusKnown={status !== null}
      tenantEnabled={status?.tenantReadsEnabled}
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

export function JiraSettingsDetail() {
  const searchParams = useSearchParams();
  const { status, isLoading, statusError, reload, busyKey, error, connect, disconnect } = useJiraConnection();
  const selection = useJiraAccountSelection(status?.configured === true && status.tenantReadsEnabled === true);

  // Pipedream redirects here after its hosted flow. The redirect proves
  // nothing; the account counts only after the backend verifies the choice.
  const flashMessage = useMemo(() => {
    const result = searchParams.get("jiraAuth");
    if (result === "return") return "Jira authorization finished. Choose the Jira site the agent should read.";
    return buildOAuthFlashMessage({ provider: "Jira", result, reason: null, successMessage: "" });
  }, [searchParams]);

  // No OAuthSettingsPage gate: the section shows its own disabled state and
  // keeps disconnect available when the organization turns Jira off.
  return (
    <JiraConnectionSection
      isLoading={isLoading}
      statusError={statusError}
      onRetry={() => void reload()}
      status={status}
      error={error}
      flashMessage={flashMessage}
      busyKey={busyKey}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      accounts={selection.accounts}
      accountsLoading={selection.isLoading}
      accountsError={selection.error}
      isSaving={selection.isSaving}
      onReloadAccounts={() => void selection.reload()}
      onLoadSites={selection.loadSites}
      onSelectSite={selection.select}
    />
  );
}
