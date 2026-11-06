"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { ConnectedAccountRow } from "./connected-account-row";
import { NotionConnectionSection } from "./notion-connection-section";
import { buildOAuthFlashMessage } from "./oauth-settings-page";
import { useNotionConnection } from "../hooks/use-notion-connection";

export function NotionAccountRow() {
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
      suspended={user?.suspended === true}
      configured={status?.configured === true && status.tenantEnabled !== false}
      statusKnown={status !== null}
      tenantEnabled={status?.tenantEnabled}
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

export function NotionSettingsDetail() {
  const searchParams = useSearchParams();
  const { status, isLoading, statusError, reload, busyKey, error, connect, disconnect, confirm } = useNotionConnection();

  const flashMessage = useMemo(
    () =>
      buildOAuthFlashMessage({
        provider: "Notion",
        result: searchParams.get("notionAuth"),
        reason: searchParams.get("reason"),
        successMessage: "Notion account connected successfully."
      }),
    [searchParams]
  );

  return (
    <NotionConnectionSection
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
    />
  );
}
