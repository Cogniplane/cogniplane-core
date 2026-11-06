"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { ConnectedAccountRow } from "./connected-account-row";
import { GithubConnectionSection } from "./github-connection-section";
import { buildOAuthFlashMessage } from "./oauth-settings-page";
import { useGithubConnection, useGithubRepositorySelection } from "../hooks/use-github-connection";

export function GithubAccountRow() {
  const { status, isLoading, busyKey, error, statusError, connect, reload } = useGithubConnection();
  return (
    <ConnectedAccountRow
      service="GitHub"
      slug="github"
      description="Repositories and pull requests"
      identity={status?.userConnection?.githubLogin ?? null}
      suspended={status?.userConnection?.suspended === true}
      configured={status?.configured === true && status.tenantEnabled !== false}
      statusKnown={status !== null}
      tenantEnabled={status?.tenantEnabled}
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

export function GithubSettingsDetail() {
  const searchParams = useSearchParams();
  const { status, isLoading, statusError, reload, busyKey, error, connect, disconnect, confirm } = useGithubConnection();
  // A suspended connection lists no repositories: the backend does not use its token.
  const selection = useGithubRepositorySelection(
    status?.configured === true && status.userConnection && !status.userConnection.suspended && status.tenantEnabled !== false
      ? status.userConnection.githubUserId
      : null
  );

  const flashMessage = useMemo(
    () =>
      buildOAuthFlashMessage({
        provider: "GitHub",
        result: searchParams.get("githubAuth"),
        reason: searchParams.get("reason"),
        successMessage: "GitHub personal authorization connected."
      }),
    [searchParams]
  );

  return (
    <GithubConnectionSection
      isLoading={isLoading}
      statusError={statusError}
      onRetry={() => void reload()}
      busyKey={busyKey}
      error={error}
      flashMessage={flashMessage}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      onConfirm={confirm}
      status={status}
      repositorySelection={{
        repositories: selection.repositories,
        truncated: selection.truncated,
        isLoading: selection.isLoading,
        loadError: selection.loadError,
        isSaving: selection.isSaving,
        saveError: selection.saveError,
        saved: selection.saved,
        onReload: () => void selection.reload(),
        onSave: selection.save
      }}
    />
  );
}
