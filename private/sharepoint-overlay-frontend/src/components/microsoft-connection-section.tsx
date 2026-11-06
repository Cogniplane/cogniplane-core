import type { MicrosoftConnectionStatus } from "../../../sharepoint-overlay-contracts/src/index";
import { OAuthConnectionActions, OAuthConnectionAvailability, OAuthConnectionOverview, OAuthConnectionReadBoundary, OAuthConnectionSectionHeading, type OAuthConnectionReadState } from "@/components/oauth-connection-presentation";
import { formatMediumDateTime } from "@/lib/time-format";
import type { OAuthConnectionBusyKey } from "@/hooks/use-oauth-connection";

type MicrosoftConnectionSectionProps = OAuthConnectionReadState & {
  status: MicrosoftConnectionStatus | null;
  error: string | null;
  flashMessage: string | null;
  busyKey: OAuthConnectionBusyKey | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onConfirm: () => void;
};

export function MicrosoftConnectionSection(input: MicrosoftConnectionSectionProps) {
  const { status } = input;
  const account = status?.userConnection ?? null;
  const suspended = account?.suspended === true;
  const available = status?.configured === true && status.tenantEnabled !== false;
  return <section id="microsoft" className="flex min-w-0 flex-col gap-5">
    <OAuthConnectionSectionHeading provider="Microsoft 365" />
    {input.flashMessage ? <p role="status" className="text-sm text-on-surface-variant">{input.flashMessage}</p> : null}
    <OAuthConnectionReadBoundary {...input} known={status !== null}>
      <OAuthConnectionOverview headline={account ? `Connected as ${account.microsoftDisplayName ?? account.microsoftEmail ?? "Microsoft user"}` : "Microsoft 365 not connected"} state={suspended ? "suspended" : account ? "connected" : "not connected"} suspended={suspended} connected={account !== null}
        description="Connect your Microsoft 365 account to let the agent access SharePoint sites, OneDrive files, and Microsoft Graph resources on your behalf."
        identity={account?.microsoftEmail ? <p>{account.microsoftEmail}</p> : null}
        diagnostics={account ? <><p>Connected: {formatMediumDateTime(account.connectedAt, "Not available")}</p><p>Last used: {formatMediumDateTime(account.lastUsedAt, "Not available")}</p><p>Token expiry: {formatMediumDateTime(account.accessTokenExpiresAt, "Not available")}</p><p>Refresh expiry: {formatMediumDateTime(account.refreshTokenExpiresAt, "Not available")}</p></> : null}>
        <OAuthConnectionAvailability provider="Microsoft 365" configured={status?.configured === true} enabled={status?.tenantEnabled !== false} />
        <OAuthConnectionActions busyKey={input.busyKey} configured={available && !input.isLoading && !input.statusError} connected={account !== null} connectLabel="Connect my Microsoft account" reconnectLabel="Reconnect my account" error={input.error === input.statusError ? null : input.error} flashMessage={null} onConnect={input.onConnect} onDisconnect={input.onDisconnect}
          // Microsoft attests the email. A display name cannot authorize confirmation.
          suspended={account && suspended ? { confirm: account.microsoftEmail ? { account: `the Microsoft account ${account.microsoftEmail}`, onConfirm: input.onConfirm } : null } : undefined} />
      </OAuthConnectionOverview>
    </OAuthConnectionReadBoundary>
  </section>;
}
