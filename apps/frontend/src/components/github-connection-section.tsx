import type { GithubConnectionStatus } from "@cogniplane/shared-types";
import { OAuthConnectionActions, OAuthConnectionAvailability, OAuthConnectionOverview, OAuthConnectionReadBoundary, OAuthConnectionSectionHeading, type OAuthConnectionReadState } from "./oauth-connection-presentation";
import { GithubRepositoryPicker, type GithubRepositoryPickerProps } from "./github-repository-picker";
import { formatMediumDateTime } from "../lib/time-format";

type GithubConnectionSectionProps = OAuthConnectionReadState & {
  status: GithubConnectionStatus | null;
  error: string | null;
  flashMessage: string | null;
  busyKey: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onConfirm: () => void;
  repositorySelection: Omit<GithubRepositoryPickerProps, "allowed" | "githubUserId">;
};

export function GithubConnectionSection(input: GithubConnectionSectionProps) {
  const { status } = input;
  const account = status?.userConnection ?? null;
  const suspended = account?.suspended === true;
  const available = status?.configured === true && status.tenantEnabled !== false;
  const readBlocked = Boolean(input.isLoading || input.statusError);
  return <section id="github" className="flex min-w-0 flex-col gap-5">
    <OAuthConnectionSectionHeading provider="GitHub" />
    {input.flashMessage ? <p role="status" className="text-sm text-on-surface-variant">{input.flashMessage}</p> : null}
    <OAuthConnectionReadBoundary {...input} known={status !== null}>
      <OAuthConnectionOverview headline={account ? `Authorized as ${account.githubLogin}` : "GitHub not connected"} state={suspended ? "suspended" : account ? "connected" : "not connected"} suspended={suspended} connected={account !== null}
        description="Connect your GitHub account so the agent can read files, write files, and open pull requests on your behalf. Choose the repositories it may use below."
        identity={account ? <p>GitHub login: {account.githubLogin}</p> : null}
        diagnostics={account ? <><p>Connected: {formatMediumDateTime(account.connectedAt, "Not available")}</p><p>Last used: {formatMediumDateTime(account.lastUsedAt, "Not available")}</p><p>Token expiry: {formatMediumDateTime(account.accessTokenExpiresAt, "Not available")}</p><p>Refresh expiry: {formatMediumDateTime(account.refreshTokenExpiresAt, "Not available")}</p></> : null}>
        <OAuthConnectionAvailability provider="GitHub" configured={status?.configured === true} enabled={status?.tenantEnabled !== false} />
        {account && !available && !suspended ? <p className="break-words text-sm text-on-surface-variant [overflow-wrap:anywhere]">Saved repository access: {account.allowedRepositories.length > 0 ? account.allowedRepositories.join(", ") : "No repositories selected."}</p> : null}
        <OAuthConnectionActions busyKey={input.busyKey === "connect" || input.busyKey === "disconnect" || input.busyKey === "confirm" ? input.busyKey : null} configured={available && !readBlocked} connected={account !== null} connectLabel="Connect GitHub" reconnectLabel="Reconnect GitHub" error={input.error === input.statusError ? null : input.error} flashMessage={null} onConnect={input.onConnect} onDisconnect={input.onDisconnect}
          suspended={account && suspended ? { confirm: { account: `the GitHub account ${account.githubLogin}`, onConfirm: input.onConfirm } } : undefined}>
          {account && suspended ? <p className="break-words text-sm text-on-surface-variant [overflow-wrap:anywhere]">{account.allowedRepositories.length > 0 ? `The agent may use these repositories after you confirm: ${account.allowedRepositories.join(", ")}.` : "The agent may use no repositories."}</p> : null}
        </OAuthConnectionActions>
      </OAuthConnectionOverview>
      {account && !suspended && available ? <GithubRepositoryPicker githubUserId={account.githubUserId} allowed={account.allowedRepositories} {...input.repositorySelection} /> : null}
    </OAuthConnectionReadBoundary>
  </section>;
}
