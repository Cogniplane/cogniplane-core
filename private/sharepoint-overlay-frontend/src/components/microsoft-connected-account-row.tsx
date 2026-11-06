"use client";

import { ConnectedAccountRow } from "../../../../apps/frontend/src/components/connected-account-row";
import { useMicrosoftConnection } from "../hooks/use-microsoft-connection";

export function MicrosoftConnectedAccountRow() {
  const { status, isLoading, busyKey, error, statusError, connect, reload } = useMicrosoftConnection();
  const user = status?.userConnection;
  return (
    <ConnectedAccountRow
      service="Microsoft 365"
      slug="microsoft"
      description="OneDrive and SharePoint files"
      identity={user ? user.microsoftDisplayName ?? user.microsoftEmail ?? "Microsoft account" : null}
      suspended={user?.suspended === true}
      configured={status?.configured === true && status.tenantEnabled !== false}
      statusKnown={status !== null}
      tenantEnabled={status?.tenantEnabled}
      isLoading={isLoading}
      busyKey={busyKey}
      error={error}
      statusError={statusError}
      detailsHref="/settings/microsoft"
      onConnect={() => void connect()}
      onRetry={() => void reload()}
    />
  );
}
