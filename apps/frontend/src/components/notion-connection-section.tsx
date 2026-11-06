import type { NotionConnectionStatus } from "@cogniplane/shared-types";
import { OAuthConnectionActions, OAuthConnectionAvailability, OAuthConnectionOverview, OAuthConnectionReadBoundary, OAuthConnectionSectionHeading, type OAuthConnectionReadState } from "./oauth-connection-presentation";
import { formatMediumDateTime } from "../lib/time-format";

type NotionConnectionSectionProps = OAuthConnectionReadState & {
  status: NotionConnectionStatus | null;
  error: string | null;
  flashMessage: string | null;
  busyKey: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onConfirm: () => void;
};

export function NotionConnectionSection(input: NotionConnectionSectionProps) {
  const { status } = input;
  const account = status?.userConnection ?? null;
  const suspended = account?.suspended === true;
  const workspace = account?.notionWorkspaceName;
  const owner = account?.notionOwnerName ?? account?.notionOwnerEmail;
  const headline = account ? workspace && owner ? `Connected as ${owner} in ${workspace}` : workspace ? `Connected to ${workspace}` : `Connected as ${owner ?? "Notion user"}` : status?.configured ? "Notion not connected" : "Notion not configured";
  const available = status?.configured === true && status.tenantEnabled !== false;
  return <section id="notion" className="flex min-w-0 flex-col gap-5">
    <OAuthConnectionSectionHeading provider="Notion" />
    {input.flashMessage ? <p role="status" className="text-sm text-on-surface-variant">{input.flashMessage}</p> : null}
    <OAuthConnectionReadBoundary {...input} known={status !== null}>
      <OAuthConnectionOverview headline={headline} state={suspended ? "suspended" : account ? "connected" : "not connected"} suspended={suspended} connected={account !== null}
        description="Connect your Notion account to search pages, read content, query databases, and create or update pages. The agent only sees the workspaces and pages you grant access to in Notion."
        identity={account ? <>{account.notionOwnerEmail ? <p>{account.notionOwnerEmail}</p> : null}{workspace ? <p>Workspace: {workspace}</p> : null}</> : null}
        diagnostics={account ? <><p>Connected: {formatMediumDateTime(account.connectedAt, "Not available")}</p><p>Last used: {formatMediumDateTime(account.lastUsedAt, "Not available")}</p><p>Token expiry: {formatMediumDateTime(account.accessTokenExpiresAt, "Not available")}</p></> : null}>
        <OAuthConnectionAvailability provider="Notion" configured={status?.configured === true} enabled={status?.tenantEnabled !== false} />
        <OAuthConnectionActions busyKey={input.busyKey === "connect" || input.busyKey === "disconnect" || input.busyKey === "confirm" ? input.busyKey : null} configured={available && !input.isLoading && !input.statusError} connected={account !== null} connectLabel="Connect my Notion account" reconnectLabel="Reconnect my account" error={input.error === input.statusError ? null : input.error} flashMessage={null} onConnect={input.onConnect} onDisconnect={input.onDisconnect}
          // Only the email is attested. A display name cannot authorize confirmation.
          suspended={account && suspended ? { confirm: account.notionOwnerEmail ? { account: `the Notion account ${account.notionOwnerEmail}`, onConfirm: input.onConfirm } : null } : undefined} />
      </OAuthConnectionOverview>
    </OAuthConnectionReadBoundary>
  </section>;
}
