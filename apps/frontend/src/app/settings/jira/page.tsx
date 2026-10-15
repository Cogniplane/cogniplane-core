"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { JiraConnectionSection } from "../../../components/jira-connection-section";
import { buildOAuthFlashMessage } from "../../../components/oauth-settings-page";
import { useJiraAccountSelection, useJiraConnection } from "../../../hooks/use-jira-connection";

export default function SettingsJiraPage() {
  const searchParams = useSearchParams();
  const { status, busyKey, error, connect, disconnect } = useJiraConnection();
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
