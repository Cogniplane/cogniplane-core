import { useState } from "react";
import type { JiraAccountCandidate, JiraConnectionStatus, JiraSite } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { OAuthConnectionBusyKey } from "../hooks/use-oauth-connection";
import { toErrorMessage } from "../lib/error-utils";
import { formatMediumDateTime } from "../lib/time-format";
import { CHIP, HINT, LIST_ITEM, PILL_BLUE, PILL_GRAY, SECTION_LABEL } from "../lib/ui-tokens";
import { OAuthConnectionActions, OAuthConnectionSectionHeading } from "./oauth-connection-presentation";

type JiraConnectionSectionProps = {
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
  const configured = status?.configured === true;
  // Disconnect stays available when the organization turns Jira off, so a
  // member can still remove their account. Connect and site choice do not.
  const enabled = status?.tenantReadsEnabled !== false;
  // Accounts are not listed while Jira is off. The status still reports an
  // authorization without a selected site, and a removal that did not finish.
  const hasRemoteAuthorizations = userConnection !== null || accounts.length > 0
    || status?.authorizationStarted === true || status?.cleanupPending === true;

  return (
    <section id="jira" className="flex flex-col gap-5">
      <OAuthConnectionSectionHeading provider="Jira" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={SECTION_LABEL}>User identity</p>
                <h2 className="text-lg font-semibold text-on-surface">Connect your Jira account</h2>
                <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
                  Authorize Jira Cloud through Pipedream, then choose one Jira site. The agent can
                  search issues and read issue details and history on that site. It cannot change
                  anything in Jira.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={PILL_GRAY}>read-only</span>
                <span className={PILL_GRAY}>per-user</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <OAuthConnectionActions
              busyKey={input.busyKey}
              locked={input.isSaving}
              configured={configured && enabled}
              connected={hasRemoteAuthorizations}
              connectLabel="Connect my Jira account"
              reconnectLabel="Connect another Jira account"
              error={input.error}
              flashMessage={input.flashMessage}
              onConnect={input.onConnect}
              onDisconnect={input.onDisconnect}
            >
              <p className={HINT}>
                Pipedream keeps the Jira credentials. Cogniplane stores only which account and site
                you chose. Disconnect removes all of your Jira accounts from Pipedream, including
                accounts without a chosen site.
              </p>
            </OAuthConnectionActions>
            {status?.cleanupPending ? (
              <p className={HINT}>
                An earlier removal did not finish in Pipedream. Select Disconnect to try again.
              </p>
            ) : null}
            {!configured ? (
              <p className={HINT}>
                Jira is not set up on this deployment yet. Contact your organization administrator.
              </p>
            ) : !enabled ? (
              <p className={HINT}>
                Your organization has not enabled Jira, so the agent cannot read Jira. Contact your
                organization administrator to turn it on. You can still disconnect your account.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={SECTION_LABEL}>Current state</p>
                <h2 className="text-lg font-semibold text-on-surface">
                  {userConnection
                    ? enabled ? `Reading ${userConnection.site.name}` : `Connected to ${userConnection.site.name}`
                    : !configured
                      ? "Jira not configured"
                      : !enabled
                        ? "Jira not enabled"
                        : "No Jira site selected"}
                </h2>
              </div>
              <span className={userConnection ? PILL_BLUE : PILL_GRAY}>
                {userConnection ? "connected" : configured ? "not connected" : "not configured"}
              </span>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {userConnection ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className={CHIP}>{userConnection.site.url}</span>
                {userConnection.accountName ? <span className={CHIP}>{userConnection.accountName}</span> : null}
                <span className={HINT}>Since {formatMediumDateTime(userConnection.connectedAt, "Not available")}</span>
              </div>
            ) : null}
            {configured && enabled ? <SitePicker {...input} selectedSiteId={userConnection?.site.siteId ?? null}
              selectedAccountId={userConnection?.accountId ?? null} /> : null}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// "Not checked" (no entry) and "failed" are different states: a failed
// lookup can be retried, and neither one means that the account is broken.
type SiteLookup = { state: "loading" } | { state: "loaded"; sites: JiraSite[] } | { state: "failed"; message: string };

function SitePicker(input: JiraConnectionSectionProps & { selectedAccountId: string | null; selectedSiteId: string | null }) {
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
        <h3 className="text-sm font-semibold text-on-surface">Jira accounts</h3>
        <Button type="button" variant="ghost" size="sm" disabled={input.accountsLoading}
          onClick={() => { setLookups({}); input.onReloadAccounts(); }}>
          {input.accountsLoading ? "Loading..." : "Refresh"}
        </Button>
      </div>
      {input.accountsError ? <p role="alert" className="text-sm text-danger">{input.accountsError}</p> : null}
      {input.accounts.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {input.accounts.map((account) => {
            const lookup = lookups[account.accountId];
            const label = account.accountName ?? "Jira account";
            return (
              <li key={account.accountId} className={`${LIST_ITEM} flex flex-col gap-2`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-on-surface">{label}</p>
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
                              <p className="truncate text-sm text-on-surface">{site.name}</p>
                              <p className="truncate text-xs text-on-surface-variant">{site.url}</p>
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
      ) : !input.accountsLoading ? (
        <p className={HINT}>
          No Jira accounts yet. Connect your Jira account, then come back to this page to choose a site.
        </p>
      ) : null}
    </div>
  );
}
