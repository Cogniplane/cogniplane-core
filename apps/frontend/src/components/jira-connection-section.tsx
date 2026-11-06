import { useState } from "react";
import type { JiraAccountCandidate, JiraConnectionStatus, JiraSite } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import type { OAuthConnectionBusyKey } from "../hooks/use-oauth-connection";
import { toErrorMessage } from "../lib/error-utils";
import { formatMediumDateTime } from "../lib/time-format";
import { HINT, LIST_ITEM, PILL_BLUE, PILL_GRAY } from "../lib/ui-tokens";
import { OAuthConnectionActions, OAuthConnectionAvailability, OAuthConnectionOverview, OAuthConnectionReadBoundary, OAuthConnectionSectionHeading, type OAuthConnectionReadState } from "./oauth-connection-presentation";

type JiraConnectionSectionProps = OAuthConnectionReadState & {
  status: JiraConnectionStatus | null;
  error: string | null;
  flashMessage: string | null;
  busyKey: OAuthConnectionBusyKey | null;
  onConnect: () => void;
  onDisconnect: () => void;
  accounts: JiraAccountCandidate[];
  accountsLoading: boolean;
  accountsError: string | null;
  isSaving: boolean;
  onReloadAccounts: () => void;
  onLoadSites: (accountId: string) => Promise<JiraSite[]>;
  onSelectSite: (input: { accountId: string; siteId: string }) => void;
};

export function JiraConnectionSection(input: JiraConnectionSectionProps) {
  const { status, accounts } = input;
  const userConnection = status?.userConnection ?? null;
  const suspended = userConnection?.suspended === true;
  const configured = status?.configured === true;
  // Disconnect stays available when the organization turns Jira off, so a
  // member can still remove their account. Connect and site choice do not.
  const enabled = status?.tenantReadsEnabled !== false;
  // Accounts are not listed while Jira is off. The status still reports an
  // authorization without a selected site, and a removal that did not finish.
  const hasRemoteAuthorizations = userConnection !== null || accounts.length > 0
    || status?.authorizationStarted === true || status?.cleanupPending === true;

  return <section id="jira" className="flex min-w-0 flex-col gap-5">
    <OAuthConnectionSectionHeading provider="Jira" />
    {input.flashMessage ? <p role="status" className="text-sm text-on-surface-variant">{input.flashMessage}</p> : null}
    <OAuthConnectionReadBoundary {...input} known={status !== null}>
      <OAuthConnectionOverview
        headline={userConnection ? suspended ? `Suspended: ${userConnection.site.name}` : enabled ? `Reading ${userConnection.site.name}` : `Connected to ${userConnection.site.name}` : !configured ? "Jira not configured" : "No Jira site selected"}
        state={suspended ? "suspended" : userConnection ? "connected" : "not connected"} suspended={suspended} connected={userConnection !== null}
        description="Connect your Jira Cloud account through Pipedream, then choose one site. The agent can search issues and read details and history on that site. It cannot change anything in Jira."
        identity={userConnection ? <><p>{userConnection.site.url}</p>{userConnection.accountName && !suspended ? <p>{userConnection.accountName}</p> : null}</> : null}
        diagnostics={userConnection ? <p>Connected: {formatMediumDateTime(userConnection.connectedAt, "Not available")}</p> : null}>
        <OAuthConnectionAvailability provider="Jira" configured={configured} enabled={enabled} />
        <OAuthConnectionActions busyKey={input.busyKey} locked={input.isSaving} configured={configured && enabled && !input.isLoading && !input.statusError} connected={hasRemoteAuthorizations} connectLabel="Connect my Jira account" reconnectLabel="Connect another Jira account" error={input.error === input.statusError ? null : input.error} flashMessage={null} onConnect={input.onConnect} onDisconnect={input.onDisconnect}
          suspended={userConnection && suspended ? { confirm: null } : undefined}>
          <p className={HINT}>Pipedream keeps the Jira credentials. Disconnect removes your local binding and asks Pipedream to remove your Jira accounts, including accounts without a chosen site. If cleanup fails, retry Disconnect. This does not revoke your Atlassian grant.</p>
        </OAuthConnectionActions>
        {status?.cleanupPending ? <p role="status" className={HINT}>An earlier removal did not finish in Pipedream. Select Disconnect to try again.</p> : null}
      </OAuthConnectionOverview>
      {configured && enabled ? <div className="min-w-0 rounded-xl border border-outline-variant bg-surface-container-lowest p-4 sm:p-6"><SitePicker {...input} selectedSiteId={userConnection?.site.siteId ?? null} selectedAccountId={userConnection?.accountId ?? null} suspended={suspended} /></div> : null}
    </OAuthConnectionReadBoundary>
  </section>;
}

// "Not checked" (no entry) and "failed" are different states: a failed
// lookup can be retried, and neither one means that the account is broken.
type SiteLookup = { state: "loading" } | { state: "loaded"; sites: JiraSite[] } | { state: "failed"; message: string };

// While the connection is suspended, accounts show their ID, not the name that
// whoever authorized them chose.
function SitePicker(input: JiraConnectionSectionProps & {
  selectedAccountId: string | null;
  selectedSiteId: string | null;
  suspended: boolean;
}) {
  const [lookups, setLookups] = useState<Record<string, SiteLookup>>({});
  const busy = input.isSaving || input.busyKey !== null;

  // One lookup per account, started by the member, so the number of
  // upstream calls stays bounded.
  const loadSites = (accountId: string) => {
    setLookups((current) => ({ ...current, [accountId]: { state: "loading" } }));
    input.onLoadSites(accountId).then(
      (sites) => setLookups((current) => ({ ...current, [accountId]: { state: "loaded", sites } })),
      (error: unknown) => setLookups((current) => ({
        ...current,
        [accountId]: { state: "failed", message: toErrorMessage(error, "Could not list the sites of this account.") }
      }))
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-on-surface">Jira accounts</h2>
        <Button type="button" variant="ghost" size="sm" disabled={input.accountsLoading}
          onClick={() => { setLookups({}); input.onReloadAccounts(); }}>
          {input.accountsLoading ? "Loading..." : "Refresh"}
        </Button>
      </div>
      {input.accountsLoading ? <p role="status" className={HINT}>Loading Jira accounts...</p> : null}
      {input.isSaving ? <p role="status" className={HINT}>Saving your Jira site...</p> : null}
      {input.accountsError ? <p role="alert" className="text-sm text-danger">{input.accountsError}</p> : null}
      {input.accounts.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {input.accounts.map((account) => {
            const lookup = lookups[account.accountId];
            const label = input.suspended ? `Jira account ${account.accountId}` : account.accountName ?? "Jira account";
            return (
              <li key={account.accountId} className={`${LIST_ITEM} flex flex-col gap-2`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-words text-sm font-medium text-on-surface [overflow-wrap:anywhere]">{label}</p>
                  {!account.healthy ? (
                    <span className={PILL_GRAY}>needs reconnection</span>
                  ) : !lookup || lookup.state === "failed" ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => loadSites(account.accountId)}
                      aria-label={`${lookup ? "Try again to show" : "Show"} sites for ${label}`}>
                      {lookup ? "Try again" : "Show sites"}
                    </Button>
                  ) : null}
                </div>
                {!account.healthy ? (
                  <p className={HINT}>Pipedream reports that this account stopped working. Connect it again.</p>
                ) : lookup?.state === "loading" ? (
                  <p role="status" className={HINT}>Loading sites...</p>
                ) : lookup?.state === "failed" ? (
                  <p role="alert" className="text-sm text-danger">{lookup.message}</p>
                ) : lookup?.state === "loaded" ? (
                  lookup.sites.length === 0 ? (
                    <p className={HINT}>This account cannot access a Jira site.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {lookup.sites.map((site) => {
                        const selected = account.accountId === input.selectedAccountId && site.siteId === input.selectedSiteId;
                        return (
                          <li key={site.siteId} className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="break-words text-sm text-on-surface [overflow-wrap:anywhere]">{site.name}</p>
                              <p className="break-words text-xs text-on-surface-variant [overflow-wrap:anywhere]">{site.url}</p>
                            </div>
                            {selected ? (
                              <span className={PILL_BLUE}>selected</span>
                            ) : (
                              <Button type="button" size="sm" variant="outline" disabled={busy}
                                onClick={() => input.onSelectSite({ accountId: account.accountId, siteId: site.siteId })}>
                                Use this site
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : account.accountId === input.selectedAccountId ? (
                  <span className={PILL_BLUE}>selected</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : !input.accountsLoading && !input.accountsError ? (
        <p className={HINT}>
          No Jira accounts yet. Connect your Jira account, then come back to this page to choose a site.
        </p>
      ) : null}
    </div>
  );
}
